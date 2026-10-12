// @vitest-environment node
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_FIT_REASONS, MAX_GAPS, REFERENCE_OUTPUT, scoreOutputSchemaFor, type ReasonItem } from "@/lib/ai/prompts/score";
import { createClaudeCliProvider } from "@/lib/ai/providers/claude-cli";
import { createCodexCliProvider } from "@/lib/ai/providers/codex-cli";
import { createOpenAiCompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import type { ProcessRunner, ProcessSpec } from "@/lib/ai/providers/process";
import { toJsonSchema } from "@/lib/ai/schema-to-json";

import { answer } from "../scoring/helpers";
import { pinnedAi } from "./helpers";

/** The answer schema with reason sources on: object items, every key required, accepted by OpenAI strict, codex and claude. */
const schema = scoreOutputSchemaFor(REFERENCE_OUTPUT, { evidence: true, quoteMaxChars: 150 });
const config = pinnedAi();
const prompt = { system: "Score it.", user: "Title: X" };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** What OpenAI-style strict structured outputs demand of a schema: every object closed and every property required. */
function strictProblems(node: unknown, at = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((child, i) => strictProblems(child, `${at}[${i}]`));
  if (!isObject(node)) return [];
  const problems: string[] = [];
  if (node.type === "object") {
    const keys = Object.keys(isObject(node.properties) ? node.properties : {});
    if (node.additionalProperties !== false) problems.push(`${at}: additionalProperties is not false`);
    const required = Array.isArray(node.required) ? node.required : [];
    if (keys.some((key) => !required.includes(key)) || required.length !== keys.length) problems.push(`${at}: not every property is required`);
  }
  for (const [key, child] of Object.entries(node)) problems.push(...strictProblems(child, `${at}.${key}`));
  return problems;
}

const items = (json: Json, key: string): Json => {
  const array = (json.properties as Record<string, Json>)[key];
  return array?.items as Json;
};

const newShape = {
  fit_reasons: [
    { text: "Python 匹配", basis: "jd", quote: "Python and RAG" },
    { text: "资深职位", basis: "inferred", quote: null },
  ],
  gaps: [{ text: "薪资未写", basis: "unstated", quote: null }],
};

describe("the answer schema with reason sources", () => {
  it("converts to JSON Schema with object items only, closed and fully required", () => {
    const json = toJsonSchema(schema);
    for (const key of ["fit_reasons", "gaps"]) {
      const item = items(json, key);
      expect(item.type).toBe("object");
      expect(item.required).toEqual(["text", "basis", "quote"]);
      expect(item.additionalProperties).toBe(false);
    }
    // no plain-string reason left anywhere in what the model is sent
    expect(JSON.stringify(items(json, "fit_reasons"))).not.toMatch(/^\{"type":"string"/);
    expect((json.properties as Record<string, Json>).fit_reasons).not.toMatchObject({ items: { type: "string" } });
    expect(strictProblems(json)).toEqual([]);
  });

  it("offers unstated to gaps only", () => {
    const json = toJsonSchema(schema);
    const basisOf = (key: string) => JSON.stringify((items(json, key).properties as Json).basis);
    expect(basisOf("fit_reasons")).not.toContain("unstated");
    expect(basisOf("fit_reasons")).toContain('"jd"');
    expect(basisOf("gaps")).toContain("unstated");
    expect(schema.safeParse(JSON.parse(answer({ fit_reasons: [{ text: "x", basis: "unstated", quote: null }] }))).success).toBe(false);
  });

  it("takes the quote limit from the options and allows a null quote", () => {
    const quoteOf = (max: number) => ((items(toJsonSchema(scoreOutputSchemaFor(REFERENCE_OUTPUT, { evidence: true, quoteMaxChars: max })), "gaps").properties as Json).quote);
    expect(JSON.stringify(quoteOf(80))).toContain('"maxLength":80');
    expect(JSON.stringify(quoteOf(80))).toContain('"type":"null"');
    expect(schema.safeParse(JSON.parse(answer({ fit_reasons: [{ text: "x", basis: "jd", quote: "q".repeat(151) }] }))).success).toBe(false);
  });

  it("accepts the new shape and an old-shape answer (plain strings become reasons without a source)", () => {
    const parsed = schema.parse(JSON.parse(answer(newShape)));
    expect(parsed.fit_reasons[0]).toEqual({ text: "Python 匹配", basis: "jd", quote: "Python and RAG" });
    const old = schema.parse(JSON.parse(answer({ fit_reasons: ["理由一", "理由二"], gaps: ["差距"] })));
    expect(old.fit_reasons).toEqual<ReasonItem[]>([
      { text: "理由一", basis: null, quote: null },
      { text: "理由二", basis: null, quote: null },
    ]);
    expect(old.gaps).toEqual([{ text: "差距", basis: null, quote: null }]);
  });

  it("treats text like the old schema: trimmed, 1 to 200 characters, at most 4 reasons and 3 gaps", () => {
    const fit = (text: string) => ({ fit_reasons: [{ text, basis: "inferred", quote: null }] });
    expect(schema.parse(JSON.parse(answer(fit("  padded  ")))).fit_reasons[0]).toMatchObject({ text: "padded" });
    expect(schema.safeParse(JSON.parse(answer(fit("x".repeat(200))))).success).toBe(true);
    expect(schema.safeParse(JSON.parse(answer(fit("x".repeat(201))))).success).toBe(false);
    expect(schema.safeParse(JSON.parse(answer(fit("   ")))).success).toBe(false);
    expect(schema.safeParse(JSON.parse(answer({ fit_reasons: Array.from({ length: MAX_FIT_REASONS + 1 }, (_, i) => `r${i}`) }))).success).toBe(false);
    expect(schema.safeParse(JSON.parse(answer({ gaps: Array.from({ length: MAX_GAPS + 1 }, (_, i) => `g${i}`) }))).success).toBe(false);
    expect(schema.safeParse(JSON.parse(answer({ fit_reasons: [{ text: "x", basis: "jd", quote: null, extra: 1 }] }))).success).toBe(false);
  });
});

function fakeFetch(content: string): { fetch: typeof fetch; bodies: Json[] } {
  const bodies: Json[] = [];
  const impl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Json);
    return new Response(JSON.stringify({ model: "m-1", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  return { fetch: impl as typeof fetch, bodies };
}

function runnerReturning(stdout: string): { run: ProcessRunner; specs: ProcessSpec[]; schemaFiles: string[] } {
  const specs: ProcessSpec[] = [];
  const schemaFiles: string[] = [];
  return {
    specs,
    schemaFiles,
    run: async (spec) => {
      specs.push(spec);
      const index = spec.args.indexOf("--output-schema");
      if (index >= 0) schemaFiles.push(fs.readFileSync(spec.args[index + 1] ?? "", "utf8"));
      return { stdout, stderr: "", exitCode: 0 };
    },
  };
}

describe("the providers take the schema", () => {
  const reply = answer(newShape);

  it("openai-compatible in strict json_schema mode", async () => {
    const { fetch: f, bodies } = fakeFetch(reply);
    const provider = createOpenAiCompatibleProvider({ id: "mimo", baseUrl: config.providers.mimo.base_url, model: config.providers.mimo.model, apiKey: "sk-test-0123456789abcdef", keyName: "K", jsonModeOnly: false, timeoutMs: 5000, maxOutputTokens: 512, fetch: f });
    const result = await provider.run("score", prompt, schema);
    expect(result.value.fit_reasons[0]).toMatchObject({ basis: "jd" });
    const format = bodies[0]?.response_format as { type: string; json_schema: { strict: boolean; schema: Json } };
    expect(format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(strictProblems(format.json_schema.schema)).toEqual([]);
  });

  it("codex --output-schema", async () => {
    const stdout = [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: reply } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })].join("\n");
    const { run, schemaFiles } = runnerReturning(stdout);
    const provider = createCodexCliProvider({ config: config.providers.codex_cli, env: { PATH: "/usr/bin", HOME: "/home/x" }, runProcess: run, authFileExists: () => true });
    const result = await provider.run("score", prompt, schema);
    expect(result.value.gaps[0]).toMatchObject({ basis: "unstated" });
    expect(strictProblems(JSON.parse(schemaFiles[0] ?? "{}"))).toEqual([]);
  });

  it("claude --json-schema", async () => {
    const envelope = { type: "result", subtype: "success", is_error: false, result: reply, structured_output: JSON.parse(reply) as Json, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-haiku-4-5": {} } };
    const { run, specs } = runnerReturning(JSON.stringify(envelope));
    const provider = createClaudeCliProvider({ config: config.providers.claude_cli, env: { PATH: "/usr/bin", HOME: "/home/x" }, runProcess: run });
    const result = await provider.run("score", prompt, schema);
    expect(result.value.fit_reasons[1]).toMatchObject({ basis: "inferred", quote: null });
    const sent = JSON.parse(specs[0]?.args[(specs[0]?.args.indexOf("--json-schema") ?? 0) + 1] ?? "{}") as Json;
    expect(strictProblems(sent)).toEqual([]);
  });
});
