// @vitest-environment node
import fs from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiProviderError } from "@/lib/ai/errors";
import { claudeArgs, createClaudeCliProvider, createClaudeCliTransport, parseClaudeOutput } from "@/lib/ai/providers/claude-cli";
import { CODEX_DEFAULT_MODEL, codexArgs, createCodexCliProvider, createCodexCliTransport, parseCodexOutput } from "@/lib/ai/providers/codex-cli";
import { childEnv, ProcessError, type ProcessRunner, type ProcessSpec } from "@/lib/ai/providers/process";

import { fixtureText, pinnedAi } from "./helpers";

const schema = z.object({ answer: z.string() });
const prompt = { system: "You answer in JSON only.", user: "Reply with answer = ok" };
const config = pinnedAi();

function runnerReturning(stdout: string, exitCode: number | null = 0): { run: ProcessRunner; specs: ProcessSpec[]; schemaFiles: string[] } {
  const specs: ProcessSpec[] = [];
  const schemaFiles: string[] = [];
  return {
    specs,
    schemaFiles,
    run: async (spec) => {
      specs.push(spec);
      const index = spec.args.indexOf("--output-schema");
      if (index >= 0) schemaFiles.push(fs.readFileSync(spec.args[index + 1] ?? "", "utf8"));
      return { stdout, stderr: "", exitCode };
    },
  };
}

describe("claude -p output parsing (recorded stdout)", () => {
  it("reads structured_output and token usage from a success envelope", () => {
    const out = parseClaudeOutput(fixtureText("claude-success-structured.json"));
    expect(JSON.parse(out.text)).toEqual({ answer: "ok" });
    expect(out.model).toBe("claude-haiku-4-5");
    expect(out.usage).toEqual({ tokensIn: 1665, tokensOut: 120, cachedIn: 0, cacheWriteIn: 0, reasoningOut: 64 });
    expect(out.usage.reported).not.toBe(false);
  });

  it("an envelope without usage is reported as unreported (never as 0 tokens)", () => {
    const envelope = JSON.parse(fixtureText("claude-success-structured.json")) as Record<string, unknown>;
    delete envelope.usage;
    const out = parseClaudeOutput(JSON.stringify(envelope));
    expect(out.usage.reported).toBe(false);
  });

  it("reads the cache and thinking sub-counts", () => {
    const envelope = JSON.parse(fixtureText("claude-success-structured.json")) as { usage: Record<string, unknown> };
    envelope.usage.cache_read_input_tokens = 500;
    envelope.usage.cache_creation_input_tokens = 100;
    const out = parseClaudeOutput(JSON.stringify(envelope));
    expect(out.usage).toEqual({ tokensIn: 2265, tokensOut: 120, cachedIn: 500, cacheWriteIn: 100, reasoningOut: 64 });
  });

  it("plannedModel is the model the call would use", () => {
    const provider = createClaudeCliProvider({ config: config.providers.claude_cli, env: { PATH: "/usr/bin" } });
    expect(provider.id).toBe("claude-cli");
    const transport = createClaudeCliTransport({ config: config.providers.claude_cli, env: { PATH: "/usr/bin" } });
    const request = { task: "score" as const, system: "s", user: "u", jsonSchema: { type: "object" as const }, strong: false };
    expect(transport.plannedModel?.(request)).toBe(config.providers.claude_cli.model);
    expect(transport.plannedModel?.({ ...request, strong: true })).toBe(config.providers.claude_cli.strong_model);
    expect(transport.plannedModel?.({ ...request, model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });

  it("falls back to the result text (fenced JSON) when there is no structured_output", () => {
    expect(parseClaudeOutput(fixtureText("claude-success-text.json")).text).toContain('"answer"');
  });

  it("classifies the recorded error envelopes", () => {
    const notLoggedIn = () => parseClaudeOutput(fixtureText("claude-error-not-logged-in.json"));
    expect(notLoggedIn).toThrow(AiProviderError);
    expect(notLoggedIn).toThrow(/Not logged in/);
    try {
      notLoggedIn();
    } catch (error) {
      expect((error as AiProviderError).kind).toBe("auth");
    }
    for (const name of ["claude-error-invalid-token.json", "claude-error-expired-session.json"]) {
      try {
        parseClaudeOutput(fixtureText(name));
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ kind: "auth", provider: "claude-cli" });
      }
    }
  });

  it("rejects non-JSON output", () => {
    expect(() => parseClaudeOutput("Segmentation fault")).toThrow(/not a JSON envelope/);
  });

  it("classifies rate limits", () => {
    const limited = JSON.stringify({ is_error: true, result: "Claude usage limit reached", api_error_status: 429 });
    expect(() => parseClaudeOutput(limited)).toThrow(expect.objectContaining({ kind: "rate_limited" }));
  });
});

describe("claude-cli provider", () => {
  it("runs the documented command line in an empty temp dir with a minimal environment", async () => {
    const { run, specs } = runnerReturning(fixtureText("claude-success-structured.json"));
    const provider = createClaudeCliProvider({
      config: config.providers.claude_cli,
      env: { PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "tok-secret-123456", ANTHROPIC_API_KEY: "other-key", DATABASE_URL: "postgres://u:p@h/db" },
      runProcess: run,
    });
    const result = await provider.run("score", prompt, schema, { strong: true });
    expect(result).toMatchObject({ value: { answer: "ok" }, provider: "claude-cli", model: "claude-haiku-4-5", usage: { tokensIn: 1665, tokensOut: 120 } });
    const spec = specs[0];
    expect(spec?.command).toBe("claude");
    expect(spec?.args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--json-schema", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--safe-mode"]));
    expect(spec?.args[spec.args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(spec?.args[spec.args.indexOf("--system-prompt") + 1]).toBe(prompt.system);
    expect(JSON.parse(spec?.args[spec.args.indexOf("--json-schema") + 1] ?? "{}")).toMatchObject({ type: "object" });
    expect(spec?.stdin).toBe(prompt.user);
    expect(spec?.timeoutMs).toBe(config.providers.claude_cli.timeout_seconds * 1000);
    expect(spec?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-secret-123456");
    expect(spec?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spec?.env).not.toHaveProperty("DATABASE_URL");
    expect(fs.existsSync(spec?.cwd ?? "")).toBe(false); // temp dir removed afterwards
  });

  it("a model on the request overrides model / strong_model", async () => {
    const { run, specs } = runnerReturning(fixtureText("claude-success-structured.json"));
    const provider = createClaudeCliProvider({ config: config.providers.claude_cli, env: { PATH: "/usr/bin" }, runProcess: run });
    await provider.run("score", prompt, schema, { strong: true, model: "claude-opus-5-5" });
    expect(specs[0]?.args[specs[0].args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });

  it("maps spawn failures: missing binary, timeout, abort", async () => {
    const fail = (kind: ProcessError["kind"]) => createClaudeCliProvider({
      config: config.providers.claude_cli,
      env: {},
      runProcess: async () => {
        throw new ProcessError(kind, "x");
      },
    });
    await expect(fail("not_found").run("score", prompt, schema)).rejects.toMatchObject({ kind: "not_configured" });
    await expect(fail("timeout").run("score", prompt, schema)).rejects.toMatchObject({ kind: "timeout" });
    await expect(fail("aborted").run("score", prompt, schema)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reports availability from the injected binary lookup, whatever is installed on this machine", () => {
    const make = (found: string | null) => createClaudeCliProvider({ config: config.providers.claude_cli, env: {}, findExecutable: () => found });
    expect(make(null).availability()).toEqual({ available: false, reason: '"claude" not found on PATH' });
    expect(make("/opt/bin/claude").availability()).toEqual({ available: true });
  });

  it("surfaces a non-zero exit with empty stdout as a provider error that includes no secrets", async () => {
    const provider = createClaudeCliProvider({
      config: config.providers.claude_cli,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-secret-123456" },
      runProcess: async () => ({ stdout: "", stderr: "boom tok-secret-123456", exitCode: 2 }),
    });
    const error = (await provider.run("score", prompt, schema).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/exit code 2/);
    expect(error.message).not.toContain("tok-secret-123456");
  });

  it("builds the argument list in a stable order", () => {
    expect(claudeArgs("m", "sys", { type: "object" })).toEqual([
      "-p", "--output-format", "json", "--json-schema", '{"type":"object"}', "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--safe-mode", "--model", "m", "--system-prompt", "sys",
    ]);
  });
});

describe("codex exec output parsing (recorded stdout)", () => {
  it("takes the last agent message and the turn usage", () => {
    const out = parseCodexOutput(fixtureText("codex-success.jsonl"));
    expect(JSON.parse(out.text)).toEqual({ answer: "ok" });
    expect(out.usage.tokensOut).toBeGreaterThan(0);
    expect(out.usage.tokensIn).toBeGreaterThan(0);
    expect(out.usage).toMatchObject({ cachedIn: 0, cacheWriteIn: 0, reasoningOut: 0 });
    expect(out.usage.reported).not.toBe(false);
  });

  it("reads the cached / cache-write / reasoning counts of turn.completed", () => {
    const stdout = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":3000,"cached_input_tokens":1000,"cache_write_input_tokens":200,"output_tokens":200,"reasoning_output_tokens":50}}',
    ].join("\n");
    expect(parseCodexOutput(stdout).usage).toEqual({ tokensIn: 3000, tokensOut: 200, cachedIn: 1000, cacheWriteIn: 200, reasoningOut: 50 });
  });

  it("a stream without turn.completed is reported as unreported", () => {
    const stdout = '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}';
    expect(parseCodexOutput(stdout).usage.reported).toBe(false);
  });

  it("plannedModel is the request's, else the configured, else the placeholder", () => {
    const request = { task: "score" as const, system: "s", user: "u", jsonSchema: { type: "object" as const }, strong: false };
    const env = { PATH: "/usr/bin", HOME: "/home/x" };
    const withModel = createCodexCliTransport({ config: { ...config.providers.codex_cli, model: "gpt-x" }, env });
    expect(withModel.plannedModel?.(request)).toBe("gpt-x");
    expect(withModel.plannedModel?.({ ...request, model: "gpt-y" })).toBe("gpt-y");
    const without = createCodexCliTransport({ config: { ...config.providers.codex_cli, model: undefined }, env });
    expect(without.plannedModel?.(request)).toBe(CODEX_DEFAULT_MODEL);
  });

  it("turns a failed turn into a classified error with the inner API message", () => {
    try {
      parseCodexOutput(fixtureText("codex-error-model.jsonl"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).message).toMatch(/not supported/);
      expect((error as AiProviderError).message).not.toContain('{"type"');
    }
  });

  it("flags a stream without an answer", () => {
    expect(() => parseCodexOutput('{"type":"thread.started","thread_id":"x"}\n')).toThrow(expect.objectContaining({ kind: "invalid_output" }));
  });

  it("classifies auth and rate-limit failures", () => {
    const failed = (message: string) => `{"type":"turn.failed","error":{"message":${JSON.stringify(message)}}}`;
    expect(() => parseCodexOutput(failed('{"status":401,"error":{"message":"token expired"}}'))).toThrow(expect.objectContaining({ kind: "auth" }));
    expect(() => parseCodexOutput(failed("You've hit your usage limit"))).toThrow(expect.objectContaining({ kind: "rate_limited" }));
  });
});

describe("codex-cli provider", () => {
  it("runs the documented command line, writes the schema file and sends the user prompt on stdin", async () => {
    const { run, specs, schemaFiles } = runnerReturning(fixtureText("codex-success.jsonl"));
    const provider = createCodexCliProvider({
      config: { ...config.providers.codex_cli, model: "gpt-x" },
      env: { PATH: "/usr/bin", HOME: "/home/x", CODEX_HOME: "/codex", OPENAI_API_KEY: "nope" },
      runProcess: run,
      authFileExists: () => true,
    });
    const result = await provider.run("score", prompt, schema);
    expect(result).toMatchObject({ value: { answer: "ok" }, provider: "codex-cli", model: "gpt-x" });
    const spec = specs[0];
    expect(spec?.command).toBe("codex");
    expect(spec?.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(spec?.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-m", "gpt-x"]));
    expect(spec?.args.at(-1)).toBe("-");
    expect(spec?.stdin).toBe(prompt.user); // trim_context: the system prompt travels as the instructions file
    expect(spec?.env.CODEX_HOME).toBe("/codex");
    expect(spec?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(JSON.parse(schemaFiles[0] ?? "{}")).toMatchObject({ type: "object", required: ["answer"] });
    expect(fs.existsSync(spec?.cwd ?? "")).toBe(false);
  });

  it("a model on the request overrides the configured one and is reported back", async () => {
    const { run, specs } = runnerReturning(fixtureText("codex-success.jsonl"));
    const provider = createCodexCliProvider({
      config: { ...config.providers.codex_cli, model: "gpt-x" },
      env: { PATH: "/usr/bin", HOME: "/home/x" },
      runProcess: run,
      authFileExists: () => true,
    });
    const result = await provider.run("score", prompt, schema, { model: "gpt-y" });
    expect(result.model).toBe("gpt-y");
    expect(specs[0]?.args[specs[0].args.indexOf("-m") + 1]).toBe("gpt-y");
  });

  it("omits -m when no model is configured", () => {
    expect(codexArgs({ schemaFile: "s.json", cwd: "/tmp/x", reasoningEffort: "low" })).not.toContain("-m");
  });

  it("is unavailable without the auth file or without the binary, each tested on its own", () => {
    const make = (binary: string | null, authFile: boolean) =>
      createCodexCliProvider({ config: config.providers.codex_cli, env: { HOME: "/h" }, findExecutable: () => binary, authFileExists: () => authFile });
    expect(make("/opt/bin/codex", false).availability()).toMatchObject({ available: false, reason: expect.stringMatching(/auth\.json/) });
    expect(make(null, true).availability()).toEqual({ available: false, reason: '"codex" not found on PATH' });
    expect(make(null, false).availability()).toEqual({ available: false, reason: '"codex" not found on PATH' });
    expect(make("/opt/bin/codex", true).availability()).toEqual({ available: true });
  });

  it("looks for the auth file under CODEX_HOME, else HOME/.codex", () => {
    const seen: string[] = [];
    const make = (env: Record<string, string>) =>
      createCodexCliProvider({ config: config.providers.codex_cli, env, findExecutable: () => "/x/codex", authFileExists: (f) => (seen.push(f), true) });
    make({ CODEX_HOME: "/c" }).availability();
    make({ HOME: "/h" }).availability();
    expect(seen).toEqual(["/c/auth.json", "/h/.codex/auth.json"]);
  });
});

describe("childEnv", () => {
  it("keeps the allow-list and the named extras only", () => {
    expect(childEnv({ PATH: "/bin", HOME: "/h", SECRET: "x", EXTRA: "y", EMPTY: "" }, ["EXTRA", "EMPTY"])).toEqual({ PATH: "/bin", HOME: "/h", EXTRA: "y" });
  });
});
