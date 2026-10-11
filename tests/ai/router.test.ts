// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ChannelLogger } from "@/lib/channels/types";
import { AiProviderError, AiUnavailableError } from "@/lib/ai/errors";
import { createAiRouter, resolveProviderOrder } from "@/lib/ai/router";
import type { AiProvider, AiProviderId } from "@/lib/ai/types";
import { createMemoryUsageStore } from "@/lib/ai/usage";

import { scriptedProvider, pinnedAi, shippedCatalog, bareCatalog, usageEntry, type Step } from "./helpers";

const schema = z.object({ ok: z.boolean() });
const prompt = { system: "s", user: "u" };
const good = '{"ok": true}';
const NOW = new Date("2026-10-07T10:00:00Z");

type Spec = Partial<Record<AiProviderId, { steps?: Step[]; available?: boolean; model?: string }>>;

function setup(spec: Spec, configEdit: (raw: Record<string, unknown>) => void = () => {}) {
  // These tests are about routing mechanics, written for claude-cli first: the shipped default is codex first.
  const config = pinnedAi((raw) => {
    raw.order = ["claude-cli", "codex-cli", "api"];
    configEdit(raw);
  });
  const transports: Partial<Record<AiProviderId, ReturnType<typeof scriptedProvider>["transport"]>> = {};
  const providers: AiProvider[] = [];
  for (const [id, detail] of Object.entries(spec) as Array<[AiProviderId, NonNullable<Spec[AiProviderId]>]>) {
    const { provider, transport } = scriptedProvider(
      id,
      detail.steps ?? [good],
      detail.available === false ? { available: false, reason: "not configured here" } : { available: true },
      detail.model,
    );
    providers.push(provider);
    transports[id] = transport;
  }
  const usage = createMemoryUsageStore();
  const router = createAiRouter({ config, providers, usage, now: () => NOW, timeZone: "Europe/Berlin", catalog: shippedCatalog() });
  return { router, usage, transports, config };
}

describe("resolveProviderOrder", () => {
  it("expands api to api_order for the global order", () => {
    expect(resolveProviderOrder(pinnedAi(), "score")).toEqual(["codex-cli", "claude-cli", "anthropic", "deepseek", "mimo"]);
  });

  it("honours api_order", () => {
    const config = pinnedAi((raw) => {
      raw.api_order = ["mimo", "anthropic", "deepseek"];
    });
    expect(resolveProviderOrder(config, "score")).toEqual(["codex-cli", "claude-cli", "mimo", "anthropic", "deepseek"]);
  });

  it("applies a per-task override, mixing named providers and the api layer, without duplicates", () => {
    const config = pinnedAi((raw) => {
      (raw.tasks as Record<string, unknown>).translate = { order: ["deepseek", "api", "codex-cli"] };
    });
    expect(resolveProviderOrder(config, "translate")).toEqual(["deepseek", "anthropic", "mimo", "codex-cli"]);
    expect(resolveProviderOrder(config, "score")).toEqual(["codex-cli", "claude-cli", "anthropic", "deepseek", "mimo"]);
  });
});

describe("routing", () => {
  it("uses the first available provider and stops", async () => {
    const { router, transports } = setup({ "claude-cli": {}, "codex-cli": {}, anthropic: {} });
    const result = await router.run("score", prompt, schema);
    expect(result).toMatchObject({ value: { ok: true }, provider: "claude-cli" });
    expect(transports["codex-cli"]?.calls).toHaveLength(0);
  });

  it("skips providers that are not configured (no key, CLI missing) and providers that are absent", async () => {
    const { router, transports } = setup({ "claude-cli": { available: false }, anthropic: { available: false }, deepseek: {} });
    const result = await router.run("score", prompt, schema);
    expect(result.provider).toBe("deepseek");
    expect(transports["claude-cli"]?.calls).toHaveLength(0);
    expect(transports.anthropic?.calls).toHaveLength(0);
  });

  it("routes a task through its own order", async () => {
    const { router, transports } = setup(
      { "claude-cli": {}, deepseek: {}, mimo: {} },
      (raw) => {
        (raw.tasks as Record<string, unknown>).translate = { order: ["mimo", "api"] };
      },
    );
    expect((await router.run("translate", prompt, schema)).provider).toBe("mimo");
    expect((await router.run("score", prompt, schema)).provider).toBe("claude-cli");
    expect(transports.deepseek?.calls).toHaveLength(0);
  });

  it("falls back to the next provider when a reply stays invalid after the retry", async () => {
    const { router, transports } = setup({ "claude-cli": { steps: ["garbage"] }, "codex-cli": {} });
    const result = await router.run("score", prompt, schema);
    expect(result.provider).toBe("codex-cli");
    expect(transports["claude-cli"]?.calls).toHaveLength(2);
  });

  it("falls back on provider errors (timeout, rate limit)", async () => {
    const { router } = setup({
      "claude-cli": { steps: [new AiProviderError("claude-cli", "timeout", "slow")] },
      "codex-cli": { steps: [new AiProviderError("codex-cli", "rate_limited", "429")] },
      anthropic: {},
    });
    expect((await router.run("score", prompt, schema)).provider).toBe("anthropic");
  });

  it("stops using a provider after an auth failure for the router's lifetime", async () => {
    const { router, transports } = setup({ "claude-cli": { steps: [new AiProviderError("claude-cli", "auth", "not logged in")] }, "codex-cli": {} });
    await router.run("score", prompt, schema);
    await router.run("score", prompt, schema);
    expect(transports["claude-cli"]?.calls).toHaveLength(1);
    expect(transports["codex-cli"]?.calls).toHaveLength(2);
  });

  it("throws AiUnavailableError listing every attempt when nothing works", async () => {
    const { router } = setup({ "claude-cli": { steps: [new AiProviderError("claude-cli", "timeout", "slow")] }, "codex-cli": { available: false }, anthropic: { steps: ["nope"] } });
    const error = await router.run("score", prompt, schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    const unavailable = error as AiUnavailableError;
    expect(unavailable.task).toBe("score");
    expect(unavailable.attempts.map((a) => [a.provider, a.outcome, a.kind])).toEqual([
      ["claude-cli", "failed", "timeout"],
      ["codex-cli", "skipped", "not_configured"],
      ["anthropic", "failed", "invalid_output"],
      ["deepseek", "skipped", "not_configured"],
      ["mimo", "skipped", "not_configured"],
    ]);
    expect(unavailable.message).toMatch(/task "score"/);
  });

  it("does not fall back when the run was aborted", async () => {
    const { router, transports } = setup({ "claude-cli": { steps: [new AiProviderError("claude-cli", "aborted", "cancelled")] }, "codex-cli": {} });
    await expect(router.run("score", prompt, schema)).rejects.toMatchObject({ kind: "aborted" });
    expect(transports["codex-cli"]?.calls).toHaveLength(0);
  });

  it("rejects an unusable schema before calling any provider", async () => {
    const { router, transports } = setup({ "claude-cli": {} });
    await expect(router.run("score", prompt, z.array(z.string()))).rejects.toMatchObject({ name: "AiSchemaError" });
    expect(transports["claude-cli"]?.calls).toHaveLength(0);
  });

  it("propagates unexpected (non-provider) errors instead of hiding bugs", async () => {
    const { router } = setup({ "claude-cli": { steps: [new TypeError("bug")] } });
    await expect(router.run("score", prompt, schema)).rejects.toThrow(TypeError);
  });
});

describe("usage and budget", () => {
  it("records one ai_usage entry per model call, CLI cost 0, API cost from pricing", async () => {
    const { router, usage } = setup({
      "claude-cli": { steps: [{ text: "garbage", tokensIn: 1000, tokensOut: 100 }, { text: "garbage", tokensIn: 1000, tokensOut: 100 }] },
      anthropic: { steps: [{ text: good, tokensIn: 1_000_000, tokensOut: 100_000, model: "claude-haiku-4-5" }] },
    });
    const result = await router.run("score", prompt, schema);
    expect(result.usage.costUsd).toBeCloseTo(1.5, 6); // 1M in * $1 + 0.1M out * $5
    expect(usage.entries.map((e) => [e.provider, e.task, e.tokensIn, e.costUsd])).toEqual([
      ["claude-cli", "score", 1000, 0],
      ["claude-cli", "score", 1000, 0],
      ["anthropic", "score", 1_000_000, 1.5],
    ]);
  });

  it("skips API providers once the monthly budget is spent, but still uses subscription CLIs", async () => {
    const { router, usage, transports } = setup(
      { anthropic: {}, deepseek: {} },
      (raw) => {
        raw.monthly_api_budget_usd = 1;
      },
    );
    await usage.record(usageEntry({ provider: "anthropic", task: "score", tokensIn: 0, tokensOut: 0, costUsd: 1, at: NOW }));
    await expect(router.run("score", prompt, schema)).rejects.toMatchObject({
      attempts: expect.arrayContaining([expect.objectContaining({ provider: "anthropic", outcome: "skipped", kind: "budget" })]),
    });
    expect(transports.anthropic?.calls).toHaveLength(0);
    expect(transports.deepseek?.calls).toHaveLength(0);
  });

  it("counts only the current month and only API providers", async () => {
    const { router, usage, transports } = setup(
      { "claude-cli": { available: false }, anthropic: {} },
      (raw) => {
        raw.monthly_api_budget_usd = 1;
      },
    );
    await usage.record(usageEntry({ provider: "anthropic", task: "score", tokensIn: 0, tokensOut: 0, costUsd: 5, at: new Date("2026-09-30T10:00:00Z") }));
    await usage.record(usageEntry({ provider: "claude-cli", task: "score", tokensIn: 0, tokensOut: 0, costUsd: 5, at: NOW }));
    expect((await router.run("score", prompt, schema)).provider).toBe("anthropic");
    expect(transports.anthropic?.calls).toHaveLength(1);
  });

  it("a budget of 0 disables the API layer", async () => {
    const { router } = setup({ anthropic: {} }, (raw) => {
      raw.monthly_api_budget_usd = 0;
    });
    await expect(router.run("score", prompt, schema)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("tracks the budget in memory when there is no usage store", async () => {
    const config = pinnedAi((raw) => {
      raw.monthly_api_budget_usd = 1;
    });
    const { provider } = scriptedProvider("anthropic", [{ text: good, tokensIn: 1_000_000, tokensOut: 0, model: "claude-haiku-4-5" }]);
    const router = createAiRouter({ config, providers: [provider], usage: null, now: () => NOW });
    await router.run("score", prompt, schema);
    await expect(router.run("score", prompt, schema)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("keeps the answer when recording usage fails", async () => {
    const { provider } = scriptedProvider("claude-cli", [good]);
    const router = createAiRouter({
      config: pinnedAi(),
      providers: [provider],
      usage: {
        record: async () => {
          throw new Error("db down");
        },
        apiSpendUsd: async () => 0,
      },
    });
    expect((await router.run("score", prompt, schema)).value).toEqual({ ok: true });
  });
});

describe("secrets (C4)", () => {
  it("never puts a credential into AiUnavailableError, even when a provider echoes it", async () => {
    const secret = "sk-live-0123456789abcdefSECRET";
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = secret;
    try {
      const { router, usage } = setup({ deepseek: { steps: [new AiProviderError("deepseek", "auth", `HTTP 401: bad key ${secret}`)] } });
      const error = (await router.run("score", prompt, schema).catch((e: unknown) => e)) as AiUnavailableError;
      expect(error.message).not.toContain(secret);
      expect(error.message).toContain("[redacted]");
      expect(JSON.stringify(usage.entries)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});

describe("model catalog in the router", () => {
  const warns: Array<{ message: string; fields: unknown }> = [];
  const logger: ChannelLogger = { debug: () => {}, info: () => {}, error: () => {}, warn: (message: string, fields?: unknown) => { warns.push({ message, fields }); }, child: () => logger };

  it("prices from the catalog by id and warns when it falls back to the highest price", async () => {
    warns.length = 0;
    const exact = scriptedProvider("anthropic", [{ text: good, tokensIn: 1_000_000, tokensOut: 0, model: "claude-haiku-4-5" }]);
    const usage = createMemoryUsageStore();
    let router = createAiRouter({ config: pinnedAi(), providers: [exact.provider], usage, now: () => NOW, catalog: shippedCatalog(), logger });
    await router.run("score", prompt, schema);
    expect(usage.entries[0]?.costUsd).toBe(1);
    expect(warns).toEqual([]);
    const mystery = scriptedProvider("anthropic", [{ text: good, tokensIn: 1_000_000, tokensOut: 0, model: "claude-mystery" }]);
    router = createAiRouter({ config: pinnedAi(), providers: [mystery.provider], usage, now: () => NOW, catalog: shippedCatalog(), logger });
    await router.run("score", prompt, schema);
    expect(usage.entries[1]?.costUsd).toBe(2);
    expect(warns).toEqual([expect.objectContaining({ message: expect.stringContaining("not in catalog") })]);
  });

  it("skips an API provider whose model has no price in the catalog, without calling it", async () => {
    const { provider, transport } = scriptedProvider("deepseek", [good]);
    const config = pinnedAi((raw) => { (raw.providers as Record<string, Record<string, unknown>>).deepseek!.model = "deepseek-unlisted"; });
    const router = createAiRouter({ config, providers: [provider], usage: null, now: () => NOW, catalog: shippedCatalog() });
    const error = (await router.run("score", prompt, schema).catch((e: unknown) => e)) as AiUnavailableError;
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.attempts).toContainEqual(expect.objectContaining({ provider: "deepseek", kind: "not_configured", message: expect.stringContaining("models.yaml") }));
    expect(transport.calls).toHaveLength(0);
  });

  it("without a catalog the API providers are skipped and the subscription CLIs go on", async () => {
    const api = scriptedProvider("anthropic", [good]);
    const cli = scriptedProvider("claude-cli", [good]);
    const router = createAiRouter({ config: pinnedAi((raw) => { raw.order = ["api", "claude-cli"]; }), providers: [api.provider, cli.provider], usage: null, now: () => NOW, catalog: null });
    const result = await router.run("score", prompt, schema);
    expect(result.provider).toBe("claude-cli");
    expect(api.transport.calls).toHaveLength(0);
  });

  it("passes the task's model to that provider only in that task, and opts.model wins", async () => {
    const config = pinnedAi((raw) => {
      raw.order = ["claude-cli"];
      raw.tasks = { score: {}, signals: {}, translate: { order: ["claude-cli"], models: { "claude-cli": "claude-sonnet-5-5" } }, summarize: {}, suggest: {} };
    });
    const { provider, transport } = scriptedProvider("claude-cli", [good]);
    const router = createAiRouter({ config, providers: [provider], usage: null, now: () => NOW, catalog: shippedCatalog() });
    await router.run("translate", prompt, schema);
    await router.run("score", prompt, schema);
    await router.run("translate", prompt, schema, { model: "claude-opus-5-5" });
    expect(transport.calls.map((c) => c.model)).toEqual(["claude-sonnet-5-5", undefined, "claude-opus-5-5"]);
  });
});

describe("usage entries", () => {
  const withCli = (raw: Record<string, unknown>) => {
    const providers = raw.providers as Record<string, { models: Record<string, unknown>[] }>;
    providers["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, source: "test" };
    providers["codex-cli"]!.models.forEach((m) => {
      if (m.cli_default) m.equivalent_price = { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, source: "test" };
    });
  };
  const make = (spec: Spec, order: string[]) => {
    // the global order only names the two CLIs and the api layer; deepseek stands for the layer, with deepseek first in it
    const config = pinnedAi((raw) => {
      raw.order = order.map((id) => (id === "deepseek" ? "api" : id));
      raw.api_order = ["deepseek", "anthropic", "mimo"];
    });
    const providers: AiProvider[] = [];
    const transports: Partial<Record<AiProviderId, ReturnType<typeof scriptedProvider>["transport"]>> = {};
    for (const [id, detail] of Object.entries(spec) as Array<[AiProviderId, NonNullable<Spec[AiProviderId]>]>) {
      const { provider, transport } = scriptedProvider(id, detail.steps ?? [good], { available: true }, detail.model);
      providers.push(provider);
      transports[id] = transport;
    }
    const usage = createMemoryUsageStore();
    const messages: Array<{ level: string; message: string }> = [];
    const logger: ChannelLogger = {
      debug: () => {},
      info: () => {},
      warn: (message) => void messages.push({ level: "warn", message }),
      error: (message) => void messages.push({ level: "error", message }),
      child: () => logger,
    };
    const router = createAiRouter({ config, providers, usage, now: () => NOW, timeZone: "Europe/Berlin", catalog: bareCatalog(withCli), logger });
    return { router, usage, transports, messages };
  };

  it("records model, source, duration, outcome, job and both costs", async () => {
    const { router, usage } = make({ "claude-cli": { model: "claude-haiku-4-5", steps: [{ text: good, tokensIn: 1_000_000, tokensOut: 1_000_000, reasoningOut: 7 }] } }, ["claude-cli"]);
    await router.run("score", prompt, schema, { jobId: 7 });
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({
      provider: "claude-cli", task: "score", model: "claude-haiku-4-5", modelSource: "call", outcome: "ok", errorKind: null, jobId: 7,
      tokensIn: 1_000_000, tokensOut: 1_000_000, tokensOutReasoning: 7, costUsd: 0, equivalentUsd: 6,
    });
    expect(usage.entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("names the catalog's cli_default for a codex call that named no model", async () => {
    const { router, usage } = make({ "codex-cli": { model: "codex-default", steps: [{ text: good, tokensIn: 1_000_000, tokensOut: 0, cachedIn: 1_000_000 }] } }, ["codex-cli"]);
    await router.run("score", prompt, schema);
    const cliDefault = shippedCatalog().providers["codex-cli"].models.find((m) => m.cli_default)?.id;
    expect(usage.entries[0]).toMatchObject({ model: cliDefault, modelSource: "cli_default", equivalentUsd: 0.1 });
  });

  it("returns the resolved model name to the caller too, the one ai_usage records", async () => {
    const { router, usage } = make({ "codex-cli": { model: "codex-default", steps: [{ text: good, tokensIn: 1, tokensOut: 1 }] } }, ["codex-cli"]);
    const result = await router.run("score", prompt, schema);
    const cliDefault = shippedCatalog().providers["codex-cli"].models.find((m) => m.cli_default)?.id;
    expect(result.model).toBe(cliDefault);
    expect(usage.entries[0]?.model).toBe(result.model);
  });

  it("records no model when the catalog has no cli_default", async () => {
    const config = pinnedAi((raw) => {
      raw.order = ["codex-cli"];
    });
    const { provider } = scriptedProvider("codex-cli", [good], undefined, "codex-default");
    const usage = createMemoryUsageStore();
    const catalog = bareCatalog((raw) => {
      const providers = raw.providers as Record<string, { models: Record<string, unknown>[] }>;
      providers["codex-cli"]!.models.forEach((m) => delete m.cli_default);
    });
    await createAiRouter({ config, providers: [provider], usage, now: () => NOW, catalog }).run("score", prompt, schema);
    expect(usage.entries[0]).toMatchObject({ model: null, modelSource: null, equivalentUsd: null });
  });

  it("writes a failed row for a provider that timed out, then the answer of the next one; skipped providers write nothing", async () => {
    const { router, usage } = make(
      { "codex-cli": { model: "codex-default", steps: [new AiProviderError("codex-cli", "timeout", "timed out")] }, "claude-cli": { model: "claude-haiku-4-5" }, deepseek: {} },
      ["codex-cli", "claude-cli", "deepseek"],
    );
    await router.run("score", prompt, schema, { skipProviders: ["deepseek"] });
    expect(usage.entries.map((e) => [e.provider, e.outcome, e.errorKind])).toEqual([
      ["codex-cli", "failed", "timeout"],
      ["claude-cli", "ok", null],
    ]);
    expect(usage.entries[0]).toMatchObject({ tokensIn: null, tokensOut: null, equivalentUsd: null, costUsd: 0 });
  });

  it("does not record a cancelled call", async () => {
    const { router, usage } = make({ "claude-cli": { steps: [new AiProviderError("claude-cli", "aborted", "cancelled")] } }, ["claude-cli"]);
    await expect(router.run("score", prompt, schema)).rejects.toMatchObject({ kind: "aborted" });
    expect(usage.entries).toHaveLength(0);
  });

  it("writes two rows when the first reply was invalid and the retry worked", async () => {
    const { router, usage } = make({ "claude-cli": { model: "claude-haiku-4-5", steps: ['{"nope": 1}', good] } }, ["claude-cli"]);
    await router.run("score", prompt, schema);
    expect(usage.entries.map((e) => e.outcome)).toEqual(["invalid_output", "ok"]);
  });

  it("stores unknown tokens as null (not 0) when the reply reported no usage, with no equivalent cost", async () => {
    const { router, usage } = make({ "claude-cli": { model: "claude-haiku-4-5", steps: [{ text: good, reported: false }] } }, ["claude-cli"]);
    await router.run("score", prompt, schema);
    expect(usage.entries[0]).toMatchObject({ tokensIn: null, tokensOut: null, tokensInCached: null, equivalentUsd: null });
  });

  it("warns when an API provider did not report usage and counts it as 0 spend", async () => {
    const { router, usage, messages } = make({ deepseek: { model: "deepseek-v4-flash", steps: [{ text: good, reported: false }] } }, ["deepseek"]);
    await router.run("score", prompt, schema);
    expect(usage.entries[0]).toMatchObject({ tokensIn: null, costUsd: 0 });
    expect(messages.some((m) => m.level === "warn" && /not reported/.test(m.message))).toBe(true);
  });

  it("an API call's equivalent cost is its actual cost, and the budget only sees the actual cost", async () => {
    const { router, usage } = make({ deepseek: { model: "deepseek-v4-flash", steps: [{ text: good, tokensIn: 1_000_000, tokensOut: 1_000_000 }] } }, ["deepseek"]);
    const result = await router.run("score", prompt, schema);
    expect(usage.entries[0]?.equivalentUsd).toBe(usage.entries[0]?.costUsd);
    expect(result.usage.costUsd).toBe(usage.entries[0]?.costUsd);
    expect(await usage.apiSpendUsd("2026-10", "Europe/Berlin")).toBe(usage.entries[0]?.costUsd);
  });
});
