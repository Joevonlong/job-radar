// @vitest-environment node
import fs from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiProviderError } from "@/lib/ai/errors";
import { CODEX_ENFORCED_CONFIG, CODEX_FEATURES_FALLBACK_OFF } from "@/lib/ai/providers/cli-guards";
import { codexArgs, createCodexCliProvider, tomlString } from "@/lib/ai/providers/codex-cli";
import { codexVersionWarning, isCodexOlderThan, parseCodexVersion, readCodexVersion } from "@/lib/ai/providers/codex-version";
import type { ProcessRunner, ProcessSpec } from "@/lib/ai/providers/process";
import { Semaphore } from "@/lib/ai/providers/semaphore";
import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";
import { fixtureText, pinnedAi } from "./helpers";

const schema = z.object({ answer: z.string() });
const prompt = { system: "SYSTEM PROMPT", user: "USER PROMPT" };
const success = fixtureText("codex-success.jsonl");
const authFailure = '{"type":"turn.failed","error":{"message":"{\\"status\\":401,\\"error\\":{\\"message\\":\\"token expired\\"}}"}}';
const base = pinnedAi().providers.codex_cli;

interface Captured {
  spec: ProcessSpec;
  instructions: string | null;
}

function recorder(stdouts: string[] = [success]): { run: ProcessRunner; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    run: async (spec) => {
      const flag = spec.args.find((a) => a.startsWith("model_instructions_file="));
      const file = flag ? (JSON.parse(flag.slice("model_instructions_file=".length)) as string) : null;
      calls.push({ spec, instructions: file ? fs.readFileSync(file, "utf8") : null });
      return { stdout: stdouts[Math.min(calls.length - 1, stdouts.length - 1)] ?? "", stderr: "", exitCode: 0 };
    },
  };
}

const make = (config: typeof base, run: ProcessRunner, extra: Partial<Parameters<typeof createCodexCliProvider>[0]> = {}) =>
  createCodexCliProvider({ config, env: { PATH: "/usr/bin" }, runProcess: run, authFileExists: () => true, sleep: async () => {}, ...extra });

const valuesAfter = (args: readonly string[], flag: string): string[] => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

describe("codex-cli G0 context trimming", () => {
  it("trim on: instructions file holds the system prompt, stdin only the user prompt, features and overrides go through -c", async () => {
    const { run, calls } = recorder();
    await make({ ...base, trim_context: true, model: "gpt-x" }, run).run("score", prompt, schema);
    const { spec, instructions } = calls[0]!;
    const c = valuesAfter(spec.args, "-c");
    expect(instructions).toBe(prompt.system);
    expect(spec.stdin).toBe(prompt.user);
    expect(c).toContain('model_reasoning_effort="low"');
    for (const feature of base.disable_features) expect(c).toContain(`features.${feature}=false`);
    for (const [key, value] of Object.entries(base.config_overrides)) expect(c).toContain(`${key}=${value}`);
    expect(c).toContain('web_search="disabled"');
    expect(c).toContain("skills.include_instructions=false");
    expect(spec.args).not.toContain("--disable");
    expect(spec.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--color", "never", "-C", spec.cwd]));
    expect(valuesAfter(spec.args, "-m")).toEqual(["gpt-x"]);
    expect(spec.args.at(-1)).toBe("-");
  });

  it("trim off: system + user on stdin, no instructions file and no context overrides, but the tools stay off", async () => {
    const { run, calls } = recorder();
    await make({ ...base, trim_context: false }, run).run("score", prompt, schema);
    const { spec, instructions } = calls[0]!;
    expect(instructions).toBeNull();
    expect(spec.stdin).toBe(`${prompt.system}\n\n${prompt.user}`);
    const c = valuesAfter(spec.args, "-c");
    expect(c[0]).toBe('model_reasoning_effort="low"');
    expect(c).not.toContain("skills.include_instructions=false");
    expect(c.some((value) => value.startsWith("model_instructions_file="))).toBe(false);
    for (const feature of [...CODEX_FEATURES_FALLBACK_OFF, ...base.disable_features]) expect(c).toContain(`features.${feature}=false`);
    expect(c.slice(-Object.keys(CODEX_ENFORCED_CONFIG).length)).toEqual(Object.entries(CODEX_ENFORCED_CONFIG).map(([key, value]) => `${key}=${value}`));
    expect(spec.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules"]));
  });

  it("reasoning effort: global default and per-task override", async () => {
    const { run, calls } = recorder();
    const provider = make({ ...base, reasoning_effort: "medium", reasoning_effort_by_task: { translate: "low" } }, run);
    await provider.run("score", prompt, schema);
    await provider.run("translate", prompt, schema);
    expect(valuesAfter(calls[0]!.spec.args, "-c")).toContain('model_reasoning_effort="medium"');
    expect(valuesAfter(calls[1]!.spec.args, "-c")).toContain('model_reasoning_effort="low"');
  });

  it("quotes any path safely as a TOML string", () => {
    const args = codexArgs({ schemaFile: "s", cwd: "/c", reasoningEffort: "low", instructionsFile: '/tmp/we ird"dir\\x/instructions.md' });
    expect(args).toContain('model_instructions_file="/tmp/we ird\\"dir\\\\x/instructions.md"');
    expect(tomlString('a"b')).toBe('"a\\"b"');
  });

  it("shipped ai.yaml keeps the trimming switches (fixture guard)", () => {
    expect(base.trim_context).toBe(true);
    expect(base.disable_features).toEqual(expect.arrayContaining(["shell_tool", "multi_agent", "plugins", "apps", "memories"]));
    expect(Object.keys(base.config_overrides)).toEqual(
      expect.arrayContaining(["web_search", "skills.include_instructions", "agents.enabled", "include_permissions_instructions", "include_environment_context"]),
    );
    // an old file may still carry the removed verified_version: accepted, ignored, no min_version needed
    expect(base.min_version).toBe("0.122.0");
  });

  it("zod rejects unsafe keys, feature names and values", () => {
    const parse = (edit: (codex: Record<string, unknown>) => void) => {
      const raw = structuredClone(shippedYaml("ai.yaml")) as { providers: { codex_cli: Record<string, unknown> } };
      edit(raw.providers.codex_cli);
      return configRegistry.ai.schema.safeParse(raw).success;
    };
    expect(parse(() => {})).toBe(true);
    expect(parse((c) => { c.disable_features = ["x=true"]; })).toBe(false);
    expect(parse((c) => { c.disable_features = ["--yolo"]; })).toBe(false);
    expect(parse((c) => { c.disable_features = ["Shell Tool"]; })).toBe(false);
    expect(parse((c) => { c.config_overrides = { "a b": "1" }; })).toBe(false);
    expect(parse((c) => { c.config_overrides = { "a=b": "1" }; })).toBe(false);
    expect(parse((c) => { c.config_overrides = { a: "1\n2" }; })).toBe(false);
    expect(parse((c) => { c.reasoning_effort = "ludicrous"; })).toBe(false);
    expect(parse((c) => { c.reasoning_effort_by_task = { bogus: "low" }; })).toBe(false);
  });
});

describe("codex-cli G7 auth retry", () => {
  it("waits and retries once after an auth failure, then succeeds", async () => {
    const { run, calls } = recorder([authFailure, success]);
    const sleeps: number[] = [];
    const provider = make({ ...base, auth_retry_seconds: 5 }, run, { sleep: async (ms) => void sleeps.push(ms) });
    const result = await provider.run("score", prompt, schema);
    expect(result.value).toEqual({ answer: "ok" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
  });

  it("fails as auth when the retry fails too (exactly two attempts)", async () => {
    const { run, calls } = recorder([authFailure]);
    const provider = make(base, run);
    await expect(provider.run("score", prompt, schema)).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry other failures or when auth_retry_seconds is 0", async () => {
    const limited = '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit"}}';
    const a = recorder([limited]);
    await expect(make(base, a.run).run("score", prompt, schema)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(a.calls).toHaveLength(1);
    const b = recorder([authFailure]);
    await expect(make({ ...base, auth_retry_seconds: 0 }, b.run).run("score", prompt, schema)).rejects.toMatchObject({ kind: "auth" });
    expect(b.calls).toHaveLength(1);
  });
});

describe("codex-cli G7 concurrency", () => {
  function gated() {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run: ProcessRunner = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { stdout: success, stderr: "", exitCode: 0 };
    };
    return { run, releases, peak: () => peak };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("never runs more than max_concurrency processes at once", async () => {
    const g = gated();
    const provider = make({ ...base, max_concurrency: 2 }, g.run, { semaphore: new Semaphore(9) });
    const all = Array.from({ length: 5 }, () => provider.run("score", prompt, schema));
    await tick();
    expect(g.releases).toHaveLength(2);
    while (g.releases.length > 0) {
      g.releases.shift()!();
      await tick();
    }
    await Promise.all(all);
    expect(g.peak()).toBe(2);
  });

  it("a waiter that is aborted leaves the queue without running", async () => {
    const g = gated();
    const provider = make({ ...base, max_concurrency: 1 }, g.run, { semaphore: new Semaphore(1) });
    const first = provider.run("score", prompt, schema);
    await tick();
    const controller = new AbortController();
    const waiting = provider.run("score", prompt, schema, { signal: controller.signal });
    const third = provider.run("score", prompt, schema);
    await tick();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ kind: "aborted" });
    g.releases.shift()!();
    await first;
    await tick();
    expect(g.releases).toHaveLength(1); // the third waiter runs, the aborted one never did
    g.releases.shift()!();
    await third;
    expect(g.peak()).toBe(1);
  });

  it("Semaphore: an already aborted signal rejects at once and a slot is only freed once", async () => {
    const s = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(s.acquire("codex-cli", controller.signal)).rejects.toBeInstanceOf(AiProviderError);
    const release = await s.acquire("codex-cli");
    release();
    release();
    expect(s.running).toBe(0);
  });
});

describe("codex version check (G6)", () => {
  it("parses codex-cli X.Y.Z", () => {
    expect(parseCodexVersion("codex-cli 0.160.1\n")).toBe("0.160.1");
    expect(parseCodexVersion("codex-cli 0.161.0-alpha.2")).toBe("0.161.0-alpha.2");
    expect(parseCodexVersion("something else")).toBeNull();
  });

  it("warns below the minimum only: equal, newer or unknown are fine", () => {
    expect(codexVersionWarning("0.121.9", "0.122.0")).toMatch(/Codex 0\.121\.9 is older than the minimum 0\.122\.0/);
    expect(codexVersionWarning("0.9.0", "0.122.0")).not.toBeNull(); // numeric, not text, comparison
    expect(codexVersionWarning("0.122.0", "0.122.0")).toBeNull();
    expect(codexVersionWarning("0.162.1", "0.122.0")).toBeNull();
    expect(codexVersionWarning("1.0.0", "0.122.0")).toBeNull();
    expect(codexVersionWarning("0.122.0-alpha.2", "0.122.0")).toBeNull();
    expect(codexVersionWarning(null, "0.122.0")).toBeNull();
    expect(isCodexOlderThan("not a version", "0.122.0")).toBe(false);
  });

  it("reads --version through the runner, caches it and returns null on failure", async () => {
    let calls = 0;
    const run: ProcessRunner = async (spec) => {
      calls += 1;
      expect(spec.args).toEqual(["--version"]);
      expect(spec.timeoutMs).toBeLessThanOrEqual(10_000);
      return { stdout: "codex-cli 0.162.0\n", stderr: "", exitCode: 0 };
    };
    expect(await readCodexVersion("codex-test-cmd", { runProcess: run, env: {} })).toBe("0.162.0");
    expect(await readCodexVersion("codex-test-cmd", { runProcess: run, env: {} })).toBe("0.162.0");
    expect(calls).toBe(1);
    const broken: ProcessRunner = async () => {
      throw new Error("boom");
    };
    expect(await readCodexVersion("codex-missing", { runProcess: broken, env: {} })).toBeNull();
  });
});
