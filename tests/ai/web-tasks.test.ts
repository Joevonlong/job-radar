// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiUnavailableError, type AiAttempt } from "@/lib/ai/errors";
import { MAX_PAUSE_CONTINUATIONS, createAnthropicProvider } from "@/lib/ai/providers/anthropic";
import { CLAUDE_WEB_MIN_VERSION, claudeArgs, claudeWebToolArgs, createClaudeCliProvider, parseClaudeVersion, versionAtLeast } from "@/lib/ai/providers/claude-cli";
import { codexArgs, codexEnforcedConfig, createCodexCliProvider } from "@/lib/ai/providers/codex-cli";
import type { ProcessRunner, ProcessSpec } from "@/lib/ai/providers/process";
import { createAiRouter } from "@/lib/ai/router";
import { AI_TASKS, type AiProviderId } from "@/lib/ai/types";
import { WEB_ACCESS_TASKS, isPublicSuffixLike, isSafeDomain, safeDomains, webAccessAllowed, webLimits } from "@/lib/ai/web-tasks";

import { fixtureText, pinnedAi, scriptedProvider } from "./helpers";

/**
 * The one exception to "AI calls never get tools". Only `salary_lookup` may reach the web, the policy is in code
 * (not ai.yaml), each transport checks it itself, and every other task's command line / request is unchanged.
 */

const schema = z.object({ answer: z.string() });
const prompt = { system: "You answer in JSON only.", user: "Reply with answer = ok" };
const config = pinnedAi();
const PROVIDERS: AiProviderId[] = ["claude-cli", "codex-cli", "anthropic", "deepseek", "mimo"];

function runnerReturning(stdout: string): { run: ProcessRunner; specs: ProcessSpec[] } {
  const specs: ProcessSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return { stdout, stderr: "", exitCode: 0 };
    },
  };
}

describe("web access policy", () => {
  it("allows the web for salary_lookup on claude-cli, codex-cli and anthropic only", () => {
    expect([...WEB_ACCESS_TASKS]).toEqual(["salary_lookup"]);
    for (const task of AI_TASKS) {
      for (const provider of PROVIDERS) {
        const expected = task === "salary_lookup" && (provider === "claude-cli" || provider === "codex-cli" || provider === "anthropic");
        expect(webAccessAllowed(task, provider), `${task} on ${provider}`).toBe(expected);
      }
    }
  });

  it("drops anything that is not a plain host name from a domain list", () => {
    expect(isSafeDomain("levels.fyi")).toBe(true);
    expect(isSafeDomain("www.glassdoor.co.uk")).toBe(true);
    for (const bad of ["--tools", "*.levels.fyi", "levels.fyi/path", "localhost", "levels.fyi:443", "lev els.fyi", ".levels.fyi", "-x.com", "a)b.com", ""]) expect(isSafeDomain(bad), bad).toBe(false);
    expect(safeDomains(["Levels.FYI", "levels.fyi", "bad domain", "kununu.com"])).toEqual(["levels.fyi", "kununu.com"]);
    expect(webLimits(["x y", "levels.fyi"], 3)).toEqual({ allowedDomains: ["levels.fyi"], maxSearches: 3, budget: { remaining: 3 } });
  });

  it("drops public suffixes: a single label, a country registry, a shared hosting suffix", () => {
    for (const suffix of ["com", "co.uk", "com.au", "ac.jp", "github.io", "herokuapp.com"]) {
      expect(isPublicSuffixLike(suffix), suffix).toBe(true);
      expect(isSafeDomain(suffix), suffix).toBe(false);
    }
    for (const site of ["levels.fyi", "glassdoor.co.uk", "seek.com.au", "kununu.com", "indeed.com", "acme.github.io"]) expect(isPublicSuffixLike(site), site).toBe(false);
    expect(safeDomains(["co.uk", "glassdoor.co.uk"])).toEqual(["glassdoor.co.uk"]);
  });
});

describe("claude-cli web tools", () => {
  it("lists WebSearch and WebFetch only, WebFetch pre-approved per host (bare and www.), in dontAsk mode, without the user's settings", () => {
    expect(claudeWebToolArgs(["levels.fyi", "www.kununu.com", "--evil", "evil.com)"])).toEqual([
      "--tools",
      "WebSearch,WebFetch",
      "--allowedTools",
      "WebSearch",
      "WebFetch(domain:levels.fyi)",
      "WebFetch(domain:www.levels.fyi)",
      "WebFetch(domain:www.kununu.com)",
      "--permission-mode",
      "dontAsk",
      // a user `permissions.allow` rule in ~/.claude/settings.json still applies under --safe-mode: not read at all
      "--setting-sources",
      "project",
    ]);
    // no usable domain: no WebFetch at all
    expect(claudeWebToolArgs(["not a domain"])).toEqual(["--tools", "WebSearch", "--allowedTools", "WebSearch", "--permission-mode", "dontAsk", "--setting-sources", "project"]);
    const args = claudeArgs("m", "sys", { type: "object" }, { domains: ["levels.fyi"] });
    // the tool set is exactly the two web tools: no Bash, Read, Write, Edit, MCP, ...
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(args.filter((arg) => arg === "--tools")).toHaveLength(1);
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "NotebookEdit"]) expect(args.join(" ")).not.toMatch(new RegExp(`\\b${tool}\\b`));
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-session-persistence", "--safe-mode"]));
  });

  it("parses and compares versions", () => {
    expect(parseClaudeVersion("2.1.296 (Claude Code)\n")).toBe("2.1.296");
    expect(parseClaudeVersion("unknown")).toBeNull();
    expect(versionAtLeast("2.1.296", CLAUDE_WEB_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.2.0", CLAUDE_WEB_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.295", CLAUDE_WEB_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("1.99.999", CLAUDE_WEB_MIN_VERSION)).toBe(false);
  });

  const provider = (readVersion: () => Promise<string | null>) => {
    const runner = runnerReturning(fixtureText("claude-success-structured.json"));
    let versionReads = 0;
    const made = createClaudeCliProvider({
      config: config.providers.claude_cli,
      env: { PATH: "/usr/bin" },
      runProcess: runner.run,
      readVersion: () => {
        versionReads += 1;
        return readVersion();
      },
    });
    return { provider: made, specs: runner.specs, reads: () => versionReads };
  };

  it("every other task keeps `--tools \"\"` and never asks for the version, whatever the request carries", async () => {
    const { provider: p, specs, reads } = provider(async () => "2.1.296");
    // a caller passing web limits to another task gets no tools: the policy, not the request, decides
    await p.run("score", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    expect(specs[0]?.args.slice(specs[0].args.indexOf("--tools"), specs[0].args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(specs[0]?.args).not.toContain("--allowedTools");
    expect(specs[0]?.args).not.toContain("--setting-sources");
    expect(reads()).toBe(0);
  });

  it("salary_lookup gets the web tools for the configured domains", async () => {
    const { provider: p, specs } = provider(async () => "2.1.296 (Claude Code)");
    await p.run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    const args = specs[0]?.args ?? [];
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(args).toEqual(expect.arrayContaining(["WebFetch(domain:levels.fyi)", "WebFetch(domain:www.levels.fyi)", "--permission-mode", "dontAsk"]));
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", "project"]);
  });

  it("asks for the CLI version again after a transient failure, and keeps a version once read", async () => {
    const specs: ProcessSpec[] = [];
    let versionCalls = 0;
    const success = fixtureText("claude-success-structured.json");
    const run: ProcessRunner = async (spec) => {
      specs.push(spec);
      if (spec.args[0] === "--version") {
        versionCalls += 1;
        return versionCalls === 1 ? { stdout: "", stderr: "busy", exitCode: 1 } : { stdout: "2.1.296 (Claude Code)\n", stderr: "", exitCode: 0 };
      }
      return { stdout: success, stderr: "", exitCode: 0 };
    };
    const p = createClaudeCliProvider({ config: config.providers.claude_cli, env: { PATH: "/usr/bin" }, runProcess: run, findExecutable: () => "/usr/bin/claude" });
    await expect(p.run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 4) })).rejects.toMatchObject({ kind: "not_configured" });
    await p.run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    await p.run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    expect(versionCalls).toBe(2);
  });

  it("fails closed on an older or unreadable CLI version, before starting a call", async () => {
    for (const version of ["2.0.1", null]) {
      const { provider: p, specs } = provider(async () => version);
      await expect(p.run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 4) })).rejects.toMatchObject({ kind: "not_configured" });
      expect(specs).toHaveLength(0);
    }
  });
});

describe("codex-cli web search", () => {
  it("keeps web_search disabled for every other task and turns on live search for salary_lookup only", () => {
    expect(codexEnforcedConfig(false).web_search).toBe('"disabled"');
    expect(codexEnforcedConfig(true)).toMatchObject({ web_search: '"live"', include_apply_patch_tool: "false", "tools.view_image": "false", approval_policy: '"never"' });
    const plain = codexArgs({ schemaFile: "s.json", cwd: "/tmp/x", reasoningEffort: "low", listedFeatures: ["shell_tool", "standalone_web_search"] });
    expect(plain).toContain('web_search="disabled"');
    const web = codexArgs({ schemaFile: "s.json", cwd: "/tmp/x", reasoningEffort: "low", listedFeatures: ["shell_tool", "standalone_web_search"], webSearch: true });
    expect(web).toContain('web_search="live"');
    expect(web).not.toContain('web_search="disabled"');
    // every listed feature stays off, the standalone web search too
    expect(web).toEqual(expect.arrayContaining(["features.shell_tool=false", "features.standalone_web_search=false"]));
  });

  const make = (listed: readonly string[] | null) => {
    const runner = runnerReturning(fixtureText("codex-success.jsonl"));
    const provider = createCodexCliProvider({
      config: config.providers.codex_cli,
      env: { PATH: "/usr/bin", HOME: "/home/x" },
      runProcess: runner.run,
      authFileExists: () => true,
      listFeatures: async () => listed,
    });
    return { provider, specs: runner.specs };
  };

  it("a scoring call stays without web search even when the request carries web limits", async () => {
    const { provider, specs } = make(["shell_tool"]);
    await provider.run("score", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    expect(specs[0]?.args).toContain('web_search="disabled"');
  });

  it("salary_lookup searches live, and fails closed when the feature list cannot be read", async () => {
    const ok = make(["shell_tool"]);
    await ok.provider.run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    expect(ok.specs[0]?.args).toContain('web_search="live"');
    expect(ok.specs[0]?.args).toContain("features.shell_tool=false");
    const unknown = make(null);
    await expect(unknown.provider.run("salary_lookup", prompt, schema)).rejects.toMatchObject({ kind: "not_configured" });
    expect(unknown.specs).toHaveLength(0);
  });
});

describe("anthropic web search", () => {
  interface Seen {
    body: Record<string, unknown>;
  }
  const reply = (content: unknown[], stopReason: string, searches = 0) =>
    new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: searches } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const answer = (input: unknown) => ({ type: "tool_use", id: "tu_1", name: "respond", input });
  const fake = (replies: Array<() => Response>) => {
    const seen: Seen[] = [];
    const impl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push({ body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
      const next = replies[Math.min(seen.length - 1, replies.length - 1)];
      if (!next) throw new Error("no reply");
      return next();
    };
    return { fetch: impl as typeof fetch, seen };
  };
  const make = (f: typeof fetch) => createAnthropicProvider({ config: config.providers.anthropic, apiKey: "sk-test-0123456789abcdef", timeoutMs: 5000, maxOutputTokens: 512, fetch: f });

  it("another task offers only respond with automatic tool choice", async () => {
    const { fetch: f, seen } = fake([() => reply([answer({ answer: "ok" })], "tool_use")]);
    await make(f).run("score", prompt, schema, { web: webLimits(["levels.fyi"], 4) });
    expect(seen[0]?.body.tool_choice).toEqual({ type: "auto" });
    expect(seen[0]?.body).not.toHaveProperty("thinking");
    expect(seen[0]?.body.system).toBe(`${prompt.system}\n\nAnswer only by calling the respond tool.`);
    expect((seen[0]?.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["respond"]);
  });

  it("salary_lookup offers web_search with the domain list and the search budget, and counts searches", async () => {
    const { fetch: f, seen } = fake([() => reply([answer({ answer: "ok" })], "tool_use", 3)]);
    const limits = webLimits(["levels.fyi", "bad domain"], 5);
    const result = await make(f).run("salary_lookup", prompt, schema, { web: limits });
    expect(result.value).toEqual({ answer: "ok" });
    expect(result.usage.webSearches).toBe(3);
    expect(seen[0]?.body.tool_choice).toEqual({ type: "auto" });
    expect(seen[0]?.body).not.toHaveProperty("thinking");
    expect(seen[0]?.body).not.toHaveProperty("effort");
    expect(seen[0]?.body).not.toHaveProperty("output_config");
    expect(seen[0]?.body.system).toBe(`${prompt.system}\n\nAnswer only by calling the respond tool.`);
    expect(seen[0]?.body.tools).toEqual([
      expect.objectContaining({ name: "respond" }),
      { type: "web_search_20250305", name: "web_search", max_uses: 5, allowed_domains: ["levels.fyi"] },
    ]);
    expect(limits.budget.remaining).toBe(2);
  });

  it("extracts respond after thinking and search content", async () => {
    const { fetch: f, seen } = fake([
      () => reply([
        { type: "thinking", thinking: "Considering the search results.", signature: "test-signature" },
        { type: "server_tool_use", id: "search_1", name: "web_search", input: { query: "salary" } },
        { type: "text", text: '{"answer":"wrong"}' },
        answer({ answer: "ok" }),
      ], "tool_use", 1),
    ]);
    const result = await make(f).run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 2) });
    expect(result).toMatchObject({ value: { answer: "ok" }, usage: { webSearches: 1 } });
    expect(seen).toHaveLength(1);
  });

  it("refuses salary_lookup without any usable domain instead of searching without a limit", async () => {
    const { fetch: f, seen } = fake([() => reply([answer({ answer: "ok" })], "tool_use")]);
    await expect(make(f).run("salary_lookup", prompt, schema, { web: webLimits(["co.uk", "bad domain"], 5) })).rejects.toMatchObject({ kind: "not_configured" });
    expect(seen).toHaveLength(0);
  });

  it("continues a paused turn with what is left of the budget, and never beyond it", async () => {
    const pausedContent = [
      { type: "thinking", thinking: "Considering search results.", signature: "test-signature" },
      { type: "text", text: "searching" },
    ];
    const paused = () => reply(pausedContent, "pause_turn", 2);
    const { fetch: f, seen } = fake([paused, () => reply([answer({ answer: "ok" })], "tool_use", 1)]);
    const limits = webLimits(["levels.fyi"], 3);
    expect((await make(f).run("salary_lookup", prompt, schema, { web: limits })).value).toEqual({ answer: "ok" });
    expect(seen).toHaveLength(2);
    expect((seen[1]?.body.tools as Array<{ max_uses?: number }>)[1]?.max_uses).toBe(1);
    expect(seen[1]?.body.messages).toEqual([{ role: "user", content: prompt.user }, { role: "assistant", content: pausedContent }]);
    expect(seen[1]?.body).not.toHaveProperty("thinking");
    expect(limits.budget.remaining).toBe(0);

    // a run that keeps pausing stops after MAX_PAUSE_CONTINUATIONS continuations; no answer -> the validation retry
    const forever = fake([() => reply([{ type: "text", text: "still searching" }], "pause_turn", 0)]);
    await expect(make(forever.fetch).run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 3) })).rejects.toMatchObject({ kind: "invalid_output" });
    expect(forever.seen.length).toBe(2 * (MAX_PAUSE_CONTINUATIONS + 1));
  });

  it("with the budget used up, a retry gets no web_search tool at all", async () => {
    const { fetch: f, seen } = fake([() => reply([{ type: "text", text: "no answer" }], "end_turn", 2), () => reply([answer({ answer: "ok" })], "tool_use")]);
    await make(f).run("salary_lookup", prompt, schema, { web: webLimits(["levels.fyi"], 2) });
    expect(seen).toHaveLength(2);
    const retryUser = (seen[1]?.body.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(retryUser).toContain("rejected by validation");
    expect(retryUser).toContain("Previous reply:\nno answer\nProblems:");
    expect(seen[1]?.body.tool_choice).toEqual({ type: "auto" });
    expect(seen[1]?.body).not.toHaveProperty("thinking");
    expect((seen[1]?.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["respond"]);
  });
});

describe("router: a web task only tries providers that can search", () => {
  it("skips deepseek and mimo for requireWeb, and fails when none is left", async () => {
    const ok = JSON.stringify({ answer: "ok" });
    const deepseek = scriptedProvider("deepseek", [ok]);
    const anthropic = scriptedProvider("anthropic", [ok]);
    const ai = pinnedAi((raw) => {
      (raw.tasks as Record<string, unknown>).salary_lookup = { order: ["deepseek", "anthropic"] };
    });
    const router = createAiRouter({ config: ai, providers: [deepseek.provider, anthropic.provider], usage: null });
    const seen: AiAttempt[] = [];
    const result = await router.run("salary_lookup", prompt, schema, { requireWeb: true, web: webLimits(["levels.fyi"], 2), onAttempt: (a) => seen.push(a) });
    expect(result.provider).toBe("anthropic");
    expect(deepseek.transport.calls).toHaveLength(0);
    expect(seen[0]).toMatchObject({ provider: "deepseek", outcome: "skipped" });
    expect(anthropic.transport.calls[0]?.web?.allowedDomains).toEqual(["levels.fyi"]);

    const onlyDeepseek = createAiRouter({ config: pinnedAi((raw) => ((raw.tasks as Record<string, unknown>).salary_lookup = { order: ["deepseek"] })), providers: [deepseek.provider], usage: null });
    await expect(onlyDeepseek.run("salary_lookup", prompt, schema, { requireWeb: true })).rejects.toBeInstanceOf(AiUnavailableError);
  });
});
