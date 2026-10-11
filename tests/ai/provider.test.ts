// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiProviderError } from "@/lib/ai/errors";
import { parseJsonReply } from "@/lib/ai/provider";

import { scriptedProvider } from "./helpers";

const schema = z.object({ score: z.number().int().min(0).max(100), reason: z.string() });
const prompt = { system: "sys", user: "rate this" };
const good = JSON.stringify({ score: 80, reason: "fits" });

describe("parseJsonReply", () => {
  it("accepts plain JSON, fenced JSON and JSON inside prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });
  it("throws on non-JSON", () => {
    expect(() => parseJsonReply("no json here")).toThrow(SyntaxError);
  });
});

describe("validation and retry", () => {
  it("returns the validated value and sums usage", async () => {
    const { provider, transport } = scriptedProvider("deepseek", [{ text: good, tokensIn: 50, tokensOut: 5 }]);
    const result = await provider.run("score", prompt, schema);
    expect(result).toMatchObject({ value: { score: 80, reason: "fits" }, provider: "deepseek", usage: { tokensIn: 50, tokensOut: 5 } });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.jsonSchema.type).toBe("object");
  });

  it("retries once with the validation errors in the prompt, then succeeds", async () => {
    const { provider, transport } = scriptedProvider("deepseek", [{ text: '{"score": 250, "reason": "x"}', tokensIn: 100, tokensOut: 10 }, { text: good, tokensIn: 150, tokensOut: 12 }]);
    const seen: number[] = [];
    const result = await provider.run("score", prompt, schema, { onCall: (c) => seen.push(c.usage.tokensIn) });
    expect(result.value.score).toBe(80);
    expect(result.usage).toEqual({ tokensIn: 250, tokensOut: 22 });
    expect(seen).toEqual([100, 150]);
    expect(transport.calls).toHaveLength(2);
    const retry = transport.calls[1];
    expect(retry?.user).toContain("rate this");
    expect(retry?.user).toMatch(/rejected by validation/);
    expect(retry?.user).toMatch(/score/);
    expect(retry?.user).toContain('"score": 250');
    expect(retry?.system).toBe("sys");
  });

  it("fails with invalid_output after the second invalid reply (no third call)", async () => {
    const { provider, transport } = scriptedProvider("mimo", ["not json at all"]);
    await expect(provider.run("score", prompt, schema)).rejects.toMatchObject({ name: "AiProviderError", kind: "invalid_output", provider: "mimo" });
    expect(transport.calls).toHaveLength(2);
  });

  it("does not retry provider-level failures", async () => {
    const { provider, transport } = scriptedProvider("mimo", [new AiProviderError("mimo", "timeout", "slow")]);
    await expect(provider.run("score", prompt, schema)).rejects.toMatchObject({ kind: "timeout" });
    expect(transport.calls).toHaveLength(1);
  });

  it("passes strong and the signal through", async () => {
    const { provider, transport } = scriptedProvider("anthropic", [good]);
    const controller = new AbortController();
    await provider.run("score", prompt, schema, { strong: true, signal: controller.signal });
    expect(transport.calls[0]).toMatchObject({ strong: true, task: "score" });
    expect(transport.calls[0]?.signal).toBe(controller.signal);
  });
});

describe("call records", () => {
  it("reports duration, outcome and the answering model for a successful call", async () => {
    const { provider } = scriptedProvider("deepseek", [good], undefined, "deepseek-v4-flash");
    const calls: Array<{ model: string | null; durationMs: number; outcome: string }> = [];
    await provider.run("score", prompt, schema, { onCall: (c) => calls.push(c) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "deepseek-v4-flash", outcome: "ok" });
    expect(Number.isInteger(calls[0]?.durationMs)).toBe(true);
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports an invalid_output record and then an ok record when the retry works", async () => {
    const { provider } = scriptedProvider("deepseek", ['{"score": 250, "reason": "x"}', good]);
    const outcomes: string[] = [];
    await provider.run("score", prompt, schema, { onCall: (c) => outcomes.push(c.outcome) });
    expect(outcomes).toEqual(["invalid_output", "ok"]);
  });

  it("reports a failed call (planned model, unreported tokens, error kind) and rethrows the original error", async () => {
    const error = new AiProviderError("deepseek", "timeout", "timed out");
    const { provider } = scriptedProvider("deepseek", [error], undefined, "deepseek-v4-flash");
    const calls: Array<{ model: string | null; outcome: string; errorKind?: string; usage: { reported?: boolean } }> = [];
    await expect(provider.run("score", prompt, schema, { onCall: (c) => calls.push(c) })).rejects.toBe(error);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "deepseek-v4-flash", outcome: "failed", errorKind: "timeout", usage: { reported: false } });
  });

  it("does not record a cancelled call", async () => {
    const { provider } = scriptedProvider("deepseek", [new AiProviderError("deepseek", "aborted", "cancelled")]);
    const calls: unknown[] = [];
    await expect(provider.run("score", prompt, schema, { onCall: (c) => calls.push(c) })).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toHaveLength(0);
  });

  it("sums the sub-counts over the calls and marks the total unreported when any call was", async () => {
    const { provider } = scriptedProvider("deepseek", [{ text: '{"score": 250, "reason": "x"}', cachedIn: 10, reasoningOut: 2 }, { text: good, cachedIn: 20, reasoningOut: 3, reported: false }]);
    const result = await provider.run("score", prompt, schema);
    expect(result.usage).toMatchObject({ tokensIn: 200, tokensOut: 20, cachedIn: 30, reasoningOut: 5, reported: false });
  });
});
