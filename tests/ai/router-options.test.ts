// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiProviderError, AiUnavailableError, type AiAttempt } from "@/lib/ai/errors";
import { createAiRouter } from "@/lib/ai/router";

import { scriptedProvider, pinnedAi } from "./helpers";

/** These tests exercise fallback from the first provider; pin translate to the global order (claude-cli first). */
const claudeFirstAi = () => pinnedAi((raw) => { raw.order = ["claude-cli", "codex-cli", "api"]; (raw.tasks as Record<string, unknown>).translate = {}; });

const schema = z.object({ ok: z.boolean() });
const prompt = { system: "s", user: "u" };
const ok = JSON.stringify({ ok: true });

function setup(claudeSteps: Parameters<typeof scriptedProvider>[1], codexSteps: Parameters<typeof scriptedProvider>[1]) {
  const claude = scriptedProvider("claude-cli", claudeSteps);
  const codex = scriptedProvider("codex-cli", codexSteps);
  return { claude, codex, router: createAiRouter({ config: claudeFirstAi(), providers: [claude.provider, codex.provider], usage: null }) };
}

describe("router run options", () => {
  it("passes timeoutMs to every call of the transports", async () => {
    const { claude, router } = setup([ok], [ok]);
    await router.run("translate", prompt, schema, { timeoutMs: 4321 });
    expect(claude.transport.calls[0]?.timeoutMs).toBe(4321);
    const { claude: other, router: r2 } = setup([ok], [ok]);
    await r2.run("translate", prompt, schema);
    expect(other.transport.calls[0]).not.toHaveProperty("timeoutMs");
  });

  it("reports a failed provider through onAttempt and still falls back", async () => {
    const { codex, router } = setup([new AiProviderError("claude-cli", "timeout", "timed out after 90s")], [ok]);
    const seen: AiAttempt[] = [];
    const result = await router.run("translate", prompt, schema, { onAttempt: (a) => seen.push(a) });
    expect(result.provider).toBe("codex-cli");
    expect(seen).toEqual([expect.objectContaining({ provider: "claude-cli", outcome: "failed", kind: "timeout" })]);
    expect(codex.transport.calls).toHaveLength(1);
  });

  it("skips the providers it is told to skip, without calling them", async () => {
    const { claude, codex, router } = setup([ok], [ok]);
    const seen: AiAttempt[] = [];
    const result = await router.run("translate", prompt, schema, { skipProviders: ["claude-cli"], onAttempt: (a) => seen.push(a) });
    expect(result.provider).toBe("codex-cli");
    expect(claude.transport.calls).toHaveLength(0);
    expect(codex.transport.calls).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: "claude-cli", outcome: "skipped" });
  });

  it("fails when every provider is skipped or failed", async () => {
    const { router } = setup([ok], [ok]);
    await expect(router.run("translate", prompt, schema, { skipProviders: ["claude-cli", "codex-cli"] })).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe("task-level output cap and API timeout", () => {
  const writeAi = (order: string[]) =>
    pinnedAi((raw) => {
      (raw.tasks as Record<string, unknown>).write = { order, max_output_tokens: 8192, api_timeout_seconds: 150 };
    });

  it("an API provider gets the task's own cap and timeout", async () => {
    const anthropic = scriptedProvider("anthropic", [ok]);
    const router = createAiRouter({ config: writeAi(["anthropic"]), providers: [anthropic.provider], usage: null });
    await router.run("write", prompt, schema);
    expect(anthropic.transport.calls[0]).toMatchObject({ maxOutputTokens: 8192, timeoutMs: 150_000 });
  });

  it("a CLI provider gets no API timeout, and a caller's timeout wins", async () => {
    const claude = scriptedProvider("claude-cli", [ok, ok]);
    const router = createAiRouter({ config: writeAi(["claude-cli"]), providers: [claude.provider], usage: null });
    await router.run("write", prompt, schema);
    expect(claude.transport.calls[0]).not.toHaveProperty("timeoutMs");
    await router.run("write", prompt, schema, { timeoutMs: 1234 });
    expect(claude.transport.calls[1]?.timeoutMs).toBe(1234);
  });

  it("other tasks keep the global cap", async () => {
    const anthropic = scriptedProvider("anthropic", [ok]);
    const config = pinnedAi((raw) => {
      (raw.tasks as Record<string, unknown>).translate = { order: ["anthropic"] };
    });
    const router = createAiRouter({ config, providers: [anthropic.provider], usage: null });
    await router.run("translate", prompt, schema);
    expect(anthropic.transport.calls[0]).not.toHaveProperty("maxOutputTokens");
  });
});
