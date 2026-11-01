// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAiRouter } from "@/lib/ai/router";
import { createOpenAiCompatibleProvider, createOpenAiCompatibleTransport, embedSchema } from "@/lib/ai/providers/openai-compatible";
import { toJsonSchema } from "@/lib/ai/schema-to-json";
import { createMemoryUsageStore } from "@/lib/ai/usage";
import type { AiCallRecord } from "@/lib/ai/types";

import { pinnedAi, shippedCatalog } from "./helpers";

const schema = z.object({ answer: z.string() });
const prompt = { system: "Be brief.", user: "Say ok" };
const KEY = "sk-test-0123456789abcdef";
const NOW = new Date("2026-10-07T10:00:00Z");

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (n: number) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
    return respond(seen.length - 1);
  };
  return { fetch: impl as typeof fetch, seen };
}

const reply = (content: string | null, usage: Record<string, unknown> = { prompt_tokens: 12, completion_tokens: 3 }, model = "m-1") =>
  new Response(JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage }), { status: 200 });

const routing = { require_parameters: true, data_collection: "deny" as const, zdr: false };

function provider(id: "openai" | "openrouter", fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {}) {
  const config = pinnedAi();
  return createOpenAiCompatibleProvider({
    id,
    baseUrl: config.providers[id].base_url,
    model: config.providers[id].model,
    apiKey: KEY,
    keyName: id === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY",
    jsonModeOnly: true,
    maxTokensField: id === "openai" ? "max_completion_tokens" : "max_tokens",
    ...(id === "openrouter" ? { routing } : {}),
    timeoutMs: 5000,
    maxOutputTokens: 512,
    fetch: fetchImpl,
    env: {},
    ...extra,
  });
}

describe("request bodies", () => {
  it("OpenAI: max_completion_tokens instead of max_tokens, JSON mode with the schema in the prompt, no provider field", async () => {
    const { fetch: f, seen } = fakeFetch(() => reply('{"answer":"ok"}'));
    await provider("openai", f).run("score", prompt, schema);
    const body = seen[0]?.body ?? {};
    expect(seen[0]?.url).toBe(`${pinnedAi().providers.openai.base_url}/chat/completions`);
    expect(body.max_completion_tokens).toBe(512);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("provider");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect((body.messages as Array<{ content: string }>)[0]?.content).toBe(embedSchema(prompt.system, toJsonSchema(schema)));
  });

  it("OpenRouter: max_tokens and the routing preferences; zdr is left out unless it is on", async () => {
    const { fetch: f, seen } = fakeFetch(() => reply('{"answer":"ok"}'));
    await provider("openrouter", f).run("score", prompt, schema);
    expect(seen[0]?.body.max_tokens).toBe(512);
    expect(seen[0]?.body).not.toHaveProperty("max_completion_tokens");
    expect(seen[0]?.body.provider).toEqual({ require_parameters: true, data_collection: "deny" });
    expect(seen[0]?.body.response_format).toEqual({ type: "json_object" });

    const strict = fakeFetch(() => reply('{"answer":"ok"}'));
    await provider("openrouter", strict.fetch, { routing: { require_parameters: false, data_collection: "allow", zdr: true } }).run("score", prompt, schema);
    expect(strict.seen[0]?.body.provider).toEqual({ require_parameters: false, data_collection: "allow", zdr: true });
  });

  it("the key goes only to the vendor's own host", () => {
    for (const id of ["openai", "openrouter"] as const) {
      const elsewhere = provider(id, fakeFetch(() => reply("{}")).fetch, { baseUrl: "https://evil.example/v1" });
      expect(elsewhere.availability().available).toBe(false);
      expect(provider(id, fakeFetch(() => reply("{}")).fetch).availability()).toEqual({ available: true });
    }
  });
});

describe("reported cost (usage.cost)", () => {
  it.each([
    { cost: 0.00123, expected: 0.00123 },
    { cost: 0, expected: 0 },
    { cost: undefined, expected: undefined },
    { cost: -0.5, expected: undefined },
    { cost: "0.1", expected: undefined },
    { cost: null, expected: undefined },
  ])("cost $cost is read as $expected", async ({ cost, expected }) => {
    const usage = { prompt_tokens: 12, completion_tokens: 3, ...(cost !== undefined ? { cost } : {}) };
    const { fetch: f } = fakeFetch(() => reply('{"answer":"ok"}', usage));
    const calls: AiCallRecord[] = [];
    const result = await provider("openrouter", f).run("score", prompt, schema, { onCall: (call) => void calls.push(call) });
    expect(calls[0]?.usage.reportedCostUsd).toBe(expected);
    // a charge belongs to one call: the run's summed usage never carries it
    expect(result.usage).not.toHaveProperty("reportedCostUsd");
  });

  it("a cost without token counts is still a charge", async () => {
    const { fetch: f } = fakeFetch(() => reply('{"answer":"ok"}', { cost: 0.002 }));
    const calls: AiCallRecord[] = [];
    await provider("openrouter", f).run("score", prompt, schema, { onCall: (call) => void calls.push(call) });
    expect(calls[0]?.usage).toMatchObject({ reported: false, reportedCostUsd: 0.002 });
  });
});

describe("failed replies keep their usage", () => {
  const transport = (f: typeof fetch) => {
    const config = pinnedAi();
    return createOpenAiCompatibleTransport({
      id: "openrouter", baseUrl: config.providers.openrouter.base_url, model: config.providers.openrouter.model, apiKey: KEY,
      keyName: "OPENROUTER_API_KEY", jsonModeOnly: true, routing, timeoutMs: 5000, maxOutputTokens: 512, fetch: f, env: {},
    });
  };
  const request = { task: "score" as const, system: "s", user: "u", jsonSchema: { type: "object" as const }, strong: false };

  it("an empty reply is invalid_output with the tokens, cost and answering model", async () => {
    const { fetch: f } = fakeFetch(() => reply("  ", { prompt_tokens: 40, completion_tokens: 0, cost: 0.0004 }, "upstream/m"));
    await expect(transport(f).call(request)).rejects.toMatchObject({
      kind: "invalid_output", model: "upstream/m", usage: { tokensIn: 40, tokensOut: 0, reportedCostUsd: 0.0004 },
    });
  });

  it("an unexpected shape is provider_error with whatever usage it carried", async () => {
    const { fetch: f } = fakeFetch(() => new Response(JSON.stringify({ model: "upstream/m", choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, cost: 0.0001 } }), { status: 200 }));
    await expect(transport(f).call(request)).rejects.toMatchObject({ kind: "provider_error", usage: { tokensIn: 9, reportedCostUsd: 0.0001 } });
    const bare = fakeFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const error = (await transport(bare.fetch).call(request).catch((e: unknown) => e)) as { usage?: unknown };
    expect(error.usage).toBeUndefined();
  });

  it("an invalid first reply and the retry are both reported to onCall, each with its own cost", async () => {
    const { fetch: f } = fakeFetch((n) => (n === 0 ? reply('{"wrong":1}', { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 }) : reply('{"answer":"ok"}', { prompt_tokens: 10, completion_tokens: 2, cost: 0.002 })));
    const calls: AiCallRecord[] = [];
    await provider("openrouter", f).run("score", prompt, schema, { onCall: (call) => void calls.push(call) });
    expect(calls.map((c) => [c.outcome, c.usage.reportedCostUsd])).toEqual([["invalid_output", 0.001], ["ok", 0.002]]);
  });

  it("an empty reply is reported to onCall as a failed call with its usage", async () => {
    const { fetch: f } = fakeFetch(() => reply(null, { prompt_tokens: 10, completion_tokens: 0, cost: 0.001 }, "upstream/m"));
    const calls: AiCallRecord[] = [];
    await expect(provider("openrouter", f).run("score", prompt, schema, { onCall: (call) => void calls.push(call) })).rejects.toMatchObject({ kind: "invalid_output" });
    expect(calls).toEqual([expect.objectContaining({ outcome: "failed", errorKind: "invalid_output", model: "upstream/m", usage: expect.objectContaining({ tokensIn: 10, reportedCostUsd: 0.001 }) })]);
  });
});

describe("the router charges what the provider reported", () => {
  function route(fetchImpl: typeof fetch, budget?: number) {
    const config = pinnedAi((raw) => {
      raw.order = ["api"];
      raw.api_order = ["openrouter"];
      if (budget !== undefined) raw.monthly_api_budget_usd = budget;
    });
    const usage = createMemoryUsageStore();
    const router = createAiRouter({ config, providers: [provider("openrouter", fetchImpl)], usage, now: () => NOW, timeZone: "Europe/Berlin", catalog: shippedCatalog() });
    return { router, usage };
  }

  it("records the reported cost of each call as exact, in ai_usage, the result and the budget", async () => {
    const model = pinnedAi().providers.openrouter.model;
    const { fetch: f } = fakeFetch((n) =>
      n === 0 ? reply('{"wrong":1}', { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.0125 }, model) : reply('{"answer":"ok"}', { prompt_tokens: 1_000_000, completion_tokens: 1000, cost: 0.0375 }, model),
    );
    const { router, usage } = route(f);
    const result = await router.run("score", prompt, schema);
    expect(usage.entries.map((e) => [e.provider, e.outcome, e.costUsd])).toEqual([
      ["openrouter", "invalid_output", 0.0125],
      ["openrouter", "ok", 0.0375],
    ]);
    expect(usage.entries[0]?.tokensIn).toBe(1_000_000);
    expect(result.usage.costUsd).toBeCloseTo(0.05, 9);
    expect(await usage.apiSpendUsd("2026-10", "Europe/Berlin")).toBeCloseTo(0.05, 9);
  });

  it("an empty reply is a failed row that still carries its charge", async () => {
    const model = pinnedAi().providers.openrouter.model;
    const { fetch: f } = fakeFetch(() => reply("", { prompt_tokens: 100, completion_tokens: 0, cost: 0.0002 }, model));
    const { router, usage } = route(f);
    await expect(router.run("score", prompt, schema)).rejects.toThrow();
    expect(usage.entries.map((e) => [e.outcome, e.errorKind, e.tokensIn, e.costUsd])).toEqual([["failed", "invalid_output", 100, 0.0002]]);
    expect(await usage.apiSpendUsd("2026-10", "Europe/Berlin")).toBeCloseTo(0.0002, 9);
  });

  it("without a reported cost the catalog prices the call", async () => {
    const model = pinnedAi().providers.openrouter.model;
    const { fetch: f } = fakeFetch(() => reply('{"answer":"ok"}', { prompt_tokens: 1_000_000, completion_tokens: 0 }, model));
    const { router, usage } = route(f);
    await router.run("score", prompt, schema);
    const input = shippedCatalog().providers.openrouter.models.find((m) => m.id === model)?.price?.input_per_mtok;
    expect(usage.entries[0]?.costUsd).toBeCloseTo(input ?? Number.NaN, 9);
  });
});
