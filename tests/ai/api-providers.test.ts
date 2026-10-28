// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toJsonSchema } from "@/lib/ai/schema-to-json";
import { createAnthropicProvider, createAnthropicTransport } from "@/lib/ai/providers/anthropic";
import { createOpenAiCompatibleProvider, createOpenAiCompatibleTransport, embedSchema } from "@/lib/ai/providers/openai-compatible";

import { pinnedAi } from "./helpers";

const schema = z.object({ answer: z.string() });
const prompt = { system: "Be brief.", user: "Say ok" };
const config = pinnedAi();
const KEY = "sk-test-0123456789abcdef";

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const item: Seen = {
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    };
    seen.push(item);
    return respond(item);
  };
  return { fetch: impl as typeof fetch, seen };
}

const completion = (content: string) =>
  new Response(JSON.stringify({ model: "m-1", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200 });

function mimo(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {}) {
  return createOpenAiCompatibleProvider({
    id: "mimo",
    baseUrl: config.providers.mimo.base_url,
    model: config.providers.mimo.model,
    apiKey: KEY,
    keyName: "MIMO_API_KEY",
    jsonModeOnly: true,
    timeoutMs: 5000,
    maxOutputTokens: 512,
    fetch: fetchImpl,
    ...extra,
  });
}

describe("openai-compatible provider", () => {
  it("MiMo path: JSON mode only, schema embedded in the system prompt, zod-validated", async () => {
    const { fetch: f, seen } = fakeFetch(() => completion('{"answer":"ok"}'));
    const result = await mimo(f).run("score", prompt, schema);
    expect(result).toMatchObject({ value: { answer: "ok" }, provider: "mimo", model: "m-1", usage: { tokensIn: 12, tokensOut: 3 } });
    const request = seen[0];
    expect(request?.url).toBe(`${config.providers.mimo.base_url}/chat/completions`);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request?.body.response_format).toEqual({ type: "json_object" });
    expect(request?.body.model).toBe(config.providers.mimo.model);
    const system = (request?.body.messages as Array<{ role: string; content: string }>)[0]?.content ?? "";
    expect(system).toContain("Be brief.");
    expect(system).toContain('"required":["answer"]');
    expect(system).toBe(embedSchema(prompt.system, toJsonSchema(schema)));
  });

  it("maps cached and reasoning tokens (OpenAI shape and DeepSeek's cache-hit field)", async () => {
    const reply = (usage: Record<string, unknown>) => () => new Response(JSON.stringify({ model: "m-1", choices: [{ message: { content: '{"answer":"ok"}' } }], usage }), { status: 200 });
    const openai = fakeFetch(reply({ prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 12 } }));
    expect((await mimo(openai.fetch).run("score", prompt, schema)).usage).toEqual({ tokensIn: 100, tokensOut: 30, cachedIn: 40, reasoningOut: 12 });
    const deepseek = fakeFetch(reply({ prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 64 }));
    expect((await mimo(deepseek.fetch).run("score", prompt, schema)).usage).toEqual({ tokensIn: 100, tokensOut: 30, cachedIn: 64 });
  });

  it("a reply without usage is reported as unreported", async () => {
    const { fetch: f } = fakeFetch(() => new Response(JSON.stringify({ model: "m-1", choices: [{ message: { content: '{"answer":"ok"}' } }] }), { status: 200 }));
    expect((await mimo(f).run("score", prompt, schema)).usage.reported).toBe(false);
  });

  it("plannedModel is the request's model, else the configured one", () => {
    const transport = createOpenAiCompatibleTransport({ id: "mimo", baseUrl: "http://x", model: "m-cfg", apiKey: KEY, keyName: "K", jsonModeOnly: true, timeoutMs: 1, maxOutputTokens: 1 });
    const request = { task: "score" as const, system: "s", user: "u", jsonSchema: { type: "object" as const }, strong: false };
    expect(transport.plannedModel?.(request)).toBe("m-cfg");
    expect(transport.plannedModel?.({ ...request, model: "m-req" })).toBe("m-req");
  });

  it("MiMo path: an invalid first reply is retried with the validation errors, then accepted", async () => {
    let n = 0;
    const { fetch: f, seen } = fakeFetch(() => completion(n++ === 0 ? '{"wrong": 1}' : '{"answer":"ok"}'));
    const result = await mimo(f).run("score", prompt, schema);
    expect(result.usage).toEqual({ tokensIn: 24, tokensOut: 6 });
    expect(seen).toHaveLength(2);
    const retryUser = (seen[1]?.body.messages as Array<{ content: string }>)[1]?.content ?? "";
    expect(retryUser).toMatch(/rejected by validation/);
  });

  it("uses json_schema (strict) when the provider is not JSON-mode-only", async () => {
    const { fetch: f, seen } = fakeFetch(() => completion('{"answer":"ok"}'));
    await mimo(f, { jsonModeOnly: false }).run("score", prompt, schema);
    expect(seen[0]?.body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, schema: { type: "object" } } });
  });

  it.each([
    [401, "auth"],
    [402, "auth"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ])("maps HTTP %i to %s and keeps the key out of the message", async (status, kind) => {
    const { fetch: f } = fakeFetch(() => new Response(JSON.stringify({ error: { message: `bad credentials ${KEY}` } }), { status }));
    const error = (await mimo(f).run("score", prompt, schema).catch((e: unknown) => e)) as Error & { kind: string };
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain(KEY);
  });

  it("reports a network failure and a timeout", async () => {
    const down = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(mimo(down.fetch).run("score", prompt, schema)).rejects.toMatchObject({ kind: "network" });
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    await expect(mimo(hang, { timeoutMs: 20 }).run("score", prompt, schema)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("is unavailable without a key and never calls the network", async () => {
    const { fetch: f, seen } = fakeFetch(() => completion("{}"));
    const provider = mimo(f, { apiKey: undefined });
    expect(provider.availability()).toEqual({ available: false, reason: "MIMO_API_KEY not set" });
    await expect(provider.run("score", prompt, schema)).rejects.toMatchObject({ kind: "not_configured" });
    expect(seen).toHaveLength(0);
  });

  it("treats an unexpected response shape as a provider error", async () => {
    const { fetch: f } = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(mimo(f).run("score", prompt, schema)).rejects.toMatchObject({ kind: "provider_error" });
  });

  it("a model on the request goes into the request body", async () => {
    const { fetch: f, seen } = fakeFetch(() => completion('{"answer":"ok"}'));
    await mimo(f).run("score", prompt, schema, { model: "mimo-other" });
    expect(seen[0]?.body.model).toBe("mimo-other");
  });
});

describe("anthropic provider", () => {
  const reply = (content: unknown[], stopReason: string | null, model = "claude-haiku-4-5") =>
    new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const message = (input: unknown, model = "claude-haiku-4-5") => reply([{ type: "tool_use", id: "tu_1", name: "respond", input }], "tool_use", model);

  const make = (fetchImpl: typeof fetch, apiKey = KEY) =>
    createAnthropicProvider({ config: config.providers.anthropic, apiKey, timeoutMs: 5000, maxOutputTokens: 512, fetch: fetchImpl });

  it("uses automatic tool choice with the respond schema and validates its input", async () => {
    const { fetch: f, seen } = fakeFetch(() => message({ answer: "ok" }));
    const result = await make(f).run("score", prompt, schema);
    expect(result).toMatchObject({ value: { answer: "ok" }, provider: "anthropic", model: "claude-haiku-4-5", usage: { tokensIn: 40, tokensOut: 7 } });
    const body = seen[0]?.body;
    expect(body?.model).toBe("claude-haiku-4-5");
    expect(body?.tool_choice).toEqual({ type: "auto" });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("effort");
    expect(body).not.toHaveProperty("output_config");
    expect(body?.system).toBe(`${prompt.system}\n\nAnswer only by calling the respond tool.`);
    expect(body?.tools).toEqual([expect.objectContaining({ name: "respond", input_schema: toJsonSchema(schema) })]);
    expect(seen[0]?.headers.get("x-api-key")).toBe(KEY);
  });

  it("extracts the respond input after thinking and other content", async () => {
    const { fetch: f, seen } = fakeFetch(() =>
      reply([
        { type: "thinking", thinking: "Considering the answer.", signature: "test-signature" },
        { type: "text", text: '{"answer":"wrong"}' },
        { type: "tool_use", id: "tu_other", name: "other", input: { answer: "wrong" } },
        { type: "tool_use", id: "tu_1", name: "respond", input: { answer: "ok" } },
      ], "tool_use"),
    );
    expect((await make(f).run("score", prompt, schema)).value).toEqual({ answer: "ok" });
    expect(seen).toHaveLength(1);
  });

  it.each([
    { behavior: "joins and trims text blocks when respond is missing", content: [{ type: "text", text: "\n  First line." }, { type: "text", text: "Second line.  \n" }], stopReason: "end_turn", text: "First line.\nSecond line." },
    { behavior: "reports the stop reason for a whitespace-only reply", content: [{ type: "text", text: " \n" }], stopReason: "max_tokens", text: "(no answer; stop_reason max_tokens)" },
    { behavior: "reports the stop reason when only thinking is present", content: [{ type: "thinking", thinking: "Considering the answer.", signature: "test-signature" }], stopReason: "end_turn", text: "(no answer; stop_reason end_turn)" },
    { behavior: "handles an empty reply with an unknown stop reason", content: [], stopReason: null, text: "(no answer; stop_reason ?)" },
  ])("$behavior", async ({ content, stopReason, text }) => {
    const { fetch: f } = fakeFetch(() => reply(content, stopReason));
    const transport = createAnthropicTransport({ config: config.providers.anthropic, apiKey: KEY, timeoutMs: 5000, maxOutputTokens: 512, fetch: f });
    expect(await transport.call({ task: "score", ...prompt, jsonSchema: toJsonSchema(schema), strong: false })).toMatchObject({ text, usage: { tokensIn: 40, tokensOut: 7 } });
  });

  it("retries a text-only reply with validation feedback and counts both calls", async () => {
    let n = 0;
    const { fetch: f, seen } = fakeFetch(() => n++ === 0 ? reply([{ type: "text", text: "  No structured answer.\n" }], "end_turn") : message({ answer: "ok" }));
    const result = await make(f).run("score", prompt, schema);
    expect(result).toMatchObject({ value: { answer: "ok" }, usage: { tokensIn: 80, tokensOut: 14 } });
    expect(seen).toHaveLength(2);
    const retryUser = (seen[1]?.body.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(retryUser).toContain("rejected by validation");
    expect(retryUser).toContain("Previous reply:\nNo structured answer.\nProblems:");
    expect(seen[1]?.body.system).toBe(seen[0]?.body.system);
  });

  it("a model on the request overrides model / strong_model", async () => {
    const { fetch: f, seen } = fakeFetch(() => message({ answer: "ok" }, "claude-opus-x"));
    await make(f).run("score", prompt, schema, { strong: true, model: "claude-opus-x" });
    expect(seen[0]?.body.model).toBe("claude-opus-x");
  });

  it("uses strong_model for strong calls", async () => {
    const { fetch: f, seen } = fakeFetch(() => message({ answer: "ok" }, "claude-sonnet-5-5"));
    await make(f).run("score", prompt, schema, { strong: true });
    expect(seen[0]?.body.model).toBe("claude-sonnet-5-5");
  });

  it("retries invalid tool input once", async () => {
    let n = 0;
    const { fetch: f, seen } = fakeFetch(() => message(n++ === 0 ? { nope: 1 } : { answer: "ok" }));
    expect((await make(f).run("score", prompt, schema)).value).toEqual({ answer: "ok" });
    expect(seen).toHaveLength(2);
  });

  it("maps 401 to auth and 429 to rate_limited without retrying inside the SDK", async () => {
    const auth = fakeFetch(() => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }), { status: 401 }));
    const error = (await make(auth.fetch).run("score", prompt, schema).catch((e: unknown) => e)) as Error & { kind: string };
    expect(error.kind).toBe("auth");
    expect(error.message).not.toContain(KEY);
    expect(auth.seen).toHaveLength(1);
    const limited = fakeFetch(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429 }));
    await expect(make(limited.fetch).run("score", prompt, schema)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(limited.seen).toHaveLength(1);
  });

  it("is unavailable without a key", () => {
    expect(make(fakeFetch(() => message({})).fetch, "").availability()).toEqual({ available: false, reason: "ANTHROPIC_API_KEY not set" });
  });
});

describe("openai-compatible provider: the key goes only to the vendor's host", () => {
  it("a changed base_url makes the provider unavailable and nothing is sent", async () => {
    const { fetch: f, seen } = fakeFetch(() => completion('{"answer":"ok"}'));
    const provider = mimo(f, { baseUrl: "https://evil.example/v1", env: {} });
    const availability = provider.availability();
    expect(availability.available).toBe(false);
    expect(availability.available ? "" : availability.reason).toContain("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1");
    await expect(provider.run("score", prompt, schema)).rejects.toMatchObject({ kind: "not_configured" });
    expect(seen).toHaveLength(0);
  });

  it("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1 lets the user point it at their own gateway", async () => {
    const { fetch: f, seen } = fakeFetch(() => completion('{"answer":"ok"}'));
    await mimo(f, { baseUrl: "https://gateway.example/v1", env: { JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" } }).run("score", prompt, schema);
    expect(seen[0]?.url).toBe("https://gateway.example/v1/chat/completions");
  });
});
