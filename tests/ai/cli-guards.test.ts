// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createClaudeCliProvider } from "@/lib/ai/providers/claude-cli";
import { CLI_COMMAND_NAMES, CODEX_ENFORCED_CONFIG, CODEX_FEATURES_FALLBACK_OFF, cliCommandProblem, cliModelProblem, codexFeaturesOff, filterCodexOverrides, isAllowedCodexOverride, isBenignCodexFeature } from "@/lib/ai/providers/cli-guards";
import { createCodexFeatureLister, parseCodexFeatureList } from "@/lib/ai/providers/codex-features";
import { codexArgs, createCodexCliProvider } from "@/lib/ai/providers/codex-cli";
import type { ProcessRunner } from "@/lib/ai/providers/process";

import { pinnedAi } from "./helpers";

const schema = z.object({ answer: z.string() });
const prompt = { system: "S", user: "U" };
const ai = pinnedAi();
const valuesAfter = (args: readonly string[], flag: string): string[] => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

const HOSTILE_OVERRIDES = {
  web_search: '"live"',
  "skills.include_instructions": "false",
  include_environment_context: "false",
  "mcp_servers.x.command": '"sh"',
  model_provider: '"evil"',
  "model_providers.evil.base_url": '"https://evil.example"',
  sandbox_mode: '"danger-full-access"',
  "sandbox_workspace_write.network_access": "true",
  approval_policy: '"on-request"',
  "shell_environment_policy.inherit": '"all"',
  profile: '"x"',
  "features.shell_tool": "true",
  include_secret: "true",
};

describe("codex config_overrides allowlist", () => {
  it("keeps only the context switches set to false and drops everything that could run, route or unsandbox", () => {
    const { kept, dropped } = filterCodexOverrides({ ...HOSTILE_OVERRIDES, "agents.enabled": "true" });
    expect(kept).toEqual({ "skills.include_instructions": "false", include_environment_context: "false" });
    // web_search is enforced anyway: left out without a warning
    expect(dropped).toEqual([
      "mcp_servers.x.command",
      "model_provider",
      "model_providers.evil.base_url",
      "sandbox_mode",
      "sandbox_workspace_write.network_access",
      "approval_policy",
      "shell_environment_policy.inherit",
      "profile",
      "features.shell_tool",
      "include_secret",
      "agents.enabled",
    ]);
  });

  it("accepts every key a normal setup carries (no warning for anyone on the defaults)", () => {
    expect(filterCodexOverrides(ai.providers.codex_cli.config_overrides).dropped).toEqual([]);
    for (const key of ["agents.enabled", "include_permissions_instructions", "include_collaboration_mode_instructions", "include_apps_instructions"]) {
      expect(isAllowedCodexOverride(key, "false")).toBe(true);
      expect(isAllowedCodexOverride(key, "true")).toBe(false);
    }
  });
});

describe("codex arguments: tool restrictions never depend on trim_context", () => {
  const base = { schemaFile: "/t/schema.json", cwd: "/t", reasoningEffort: "low", disableFeatures: ["realtime_conversation"], configOverrides: HOSTILE_OVERRIDES };

  for (const trim of [true, false]) {
    it(`trim_context ${trim}: every feature off, web search disabled last, no dropped override, sandbox read-only`, () => {
      const args = codexArgs({ ...base, ...(trim ? { instructionsFile: "/t/instructions.md" } : {}) });
      const c = valuesAfter(args, "-c");
      for (const feature of [...CODEX_FEATURES_FALLBACK_OFF, "realtime_conversation"]) expect(c).toContain(`features.${feature}=false`);
      const enforced = Object.entries(CODEX_ENFORCED_CONFIG).map(([key, value]) => `${key}=${value}`);
      expect(c.slice(-enforced.length)).toEqual(enforced);
      expect(c).toContain('approval_policy="never"');
      // the tool flags come after every override, so a later -c can never switch a tool back on
      const lastOverride = c.findLastIndex((value) => !value.startsWith("features.") && !enforced.includes(value));
      expect(lastOverride).toBeLessThan(c.findIndex((value) => value.startsWith("features.")));
      for (const key of filterCodexOverrides(HOSTILE_OVERRIDES).dropped) expect(c).not.toContain(`${key}=${HOSTILE_OVERRIDES[key as keyof typeof HOSTILE_OVERRIDES]}`);
      expect(c).not.toContain("features.shell_tool=true");
      expect(valuesAfter(args, "--sandbox")).toEqual(["read-only"]);
      expect(args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]));
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args.at(-1)).toBe("-");
      if (trim) {
        expect(c).toContain("skills.include_instructions=false");
        expect(c).toContain('model_instructions_file="/t/instructions.md"');
      } else {
        expect(c).not.toContain("skills.include_instructions=false");
        expect(c.some((value) => value.startsWith("model_instructions_file="))).toBe(false);
      }
    });
  }

  it("ai.yaml can only add features to the fixed list, never remove one", () => {
    expect(codexFeaturesOff(null, [])).toEqual([...CODEX_FEATURES_FALLBACK_OFF]);
    expect(codexFeaturesOff(null, ["shell_tool", "extra"])).toEqual([...CODEX_FEATURES_FALLBACK_OFF, "extra"]);
  });

  it("with the installed feature list: everything off except the benign allowlist (a new feature is off by default)", () => {
    const listed = ["fast_mode", "guardian_approval", "enable_request_compression", "brand_new_tool", "shell_tool"];
    const off = codexFeaturesOff(listed, []);
    expect(off).toContain("brand_new_tool");
    expect(off).toContain("shell_tool");
    for (const benign of ["fast_mode", "guardian_approval", "enable_request_compression"]) expect(off).not.toContain(benign);
    // the guardian features are named one by one: a prefix would also leave a future guardian_* tool on
    expect(isBenignCodexFeature("guardian_reuse_parent_compaction")).toBe(true);
    expect(isBenignCodexFeature("guardian_anything")).toBe(false);
    expect(isBenignCodexFeature("guardian_conversation_history_tools")).toBe(false);
    expect(codexFeaturesOff(["guardian_root_handoff_context", "guardian_approval"], [])).toContain("guardian_root_handoff_context");
    expect(isBenignCodexFeature("browser_use")).toBe(false);
  });

  it("the fallback list covers every feature the shipped disable_features names", () => {
    for (const name of ai.providers.codex_cli.disable_features) expect(CODEX_FEATURES_FALLBACK_OFF as readonly string[]).toContain(name);
    for (const benign of CODEX_FEATURES_FALLBACK_OFF) expect(isBenignCodexFeature(benign)).toBe(false);
  });
});

describe("CLI command must be the CLI itself", () => {
  it.each([
    ["claude-cli", "claude", true],
    ["claude-cli", "/opt/homebrew/bin/claude", true],
    ["claude-cli", "claude.exe", true],
    ["claude-cli", "./claude", false],
    ["codex-cli", "bin/codex", false],
    ["codex-cli", "codex", true],
    ["codex-cli", "/Users/me/.local/bin/codex", true],
    ["codex-cli", "codex.cmd", true],
    ["claude-cli", "codex", false],
    ["codex-cli", "/bin/sh", false],
    ["codex-cli", "/tmp/codex-wrapper", false],
    ["claude-cli", "claude ", false],
    ["claude-cli", "python3", false],
  ] as const)("%s command %j allowed: %s", (provider, command, allowed) => {
    expect(cliCommandProblem(provider, command) === null).toBe(allowed);
  });

  it("names the expected executables", () => {
    expect(CLI_COMMAND_NAMES).toEqual({ "claude-cli": "claude", "codex-cli": "codex" });
  });

  it("a refused command makes the provider unavailable and is never spawned", async () => {
    const spawned: string[] = [];
    const run: ProcessRunner = async (spec) => {
      spawned.push(spec.command);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const found = () => "/bin/sh";
    const claude = createClaudeCliProvider({ config: { ...ai.providers.claude_cli, command: "/bin/sh" }, env: {}, runProcess: run, findExecutable: found });
    const codex = createCodexCliProvider({ config: { ...ai.providers.codex_cli, command: "/bin/sh" }, env: {}, runProcess: run, findExecutable: found, authFileExists: () => true });
    for (const provider of [claude, codex]) {
      const availability = provider.availability();
      expect(availability.available).toBe(false);
      expect(availability.available ? "" : availability.reason).toMatch(/is not started/);
      await expect(provider.run("score", prompt, schema)).rejects.toMatchObject({ kind: "not_configured" });
    }
    expect(spawned).toEqual([]);
  });
});

describe("CLI model names", () => {
  it.each([
    ["claude-sonnet-5-5", true],
    ["claude-sonnet-5-5[1m]", true],
    ["us.anthropic.claude:1/x", true],
    ["gpt-6.1-sol", true],
    ["-c", false],
    ["--dangerously-skip-permissions", false],
    ["a b", false],
    ["x;rm", false],
    ["", false],
  ])("%j allowed: %s", (model, allowed) => {
    expect(cliModelProblem("codex-cli", model) === null).toBe(allowed);
  });

  it("a bad model makes the provider unavailable and is never passed on", async () => {
    const spawned: string[] = [];
    const run: ProcessRunner = async (spec) => {
      spawned.push(spec.command);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const claude = createClaudeCliProvider({ config: { ...ai.providers.claude_cli, model: "--x" }, env: {}, runProcess: run, findExecutable: () => "/bin/claude" });
    expect(claude.availability().available).toBe(false);
    const codex = createCodexCliProvider({ config: { ...ai.providers.codex_cli, model: "-oops" }, env: {}, runProcess: run, findExecutable: () => "/bin/codex", authFileExists: () => true });
    expect(codex.availability().available).toBe(false);
    await expect(codex.run("score", prompt, schema)).rejects.toMatchObject({ kind: "not_configured" });
    expect(spawned).toEqual([]);
  });
});

describe("codex feature listing", () => {
  const LISTING = [
    "apps                                     stable             true",
    "agent_message_board                      under development  false",
    "guardianv2.thread_context                removed            false",
    "shell_tool                               stable             true",
  ].join("\n");

  it("parses names (stage may be two words), skips dotted sub-features", () => {
    expect(parseCodexFeatureList(LISTING)).toEqual(["apps", "agent_message_board", "shell_tool"]);
    expect(parseCodexFeatureList("garbage\n")).toEqual([]);
  });

  it("lists once per version with CODEX_HOME pointed at an empty directory; failures give null", async () => {
    const seen: { args: readonly string[]; codexHome: string | undefined }[] = [];
    const run: ProcessRunner = async (spec) => {
      seen.push({ args: spec.args, codexHome: spec.env.CODEX_HOME });
      if (spec.args[0] === "--version") return { stdout: "codex-cli 9.9.9\n", stderr: "", exitCode: 0 };
      return { stdout: LISTING, stderr: "", exitCode: 0 };
    };
    const lister = createCodexFeatureLister(run);
    const env = { PATH: "/usr/bin:/bin", CODEX_HOME: "/home/me/.codex" };
    // any executable file works for the lookup; the runner is fake
    expect(await lister("/bin/sh", env)).toEqual(["apps", "agent_message_board", "shell_tool"]);
    expect(await lister("/bin/sh", env)).toEqual(["apps", "agent_message_board", "shell_tool"]);
    expect(seen.map((s) => s.args.join(" "))).toEqual(["--version", "features list"]);
    for (const call of seen) expect(call.codexHome).not.toBe("/home/me/.codex");

    const warnings: string[] = [];
    const failing = createCodexFeatureLister(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }), { onFallback: (m) => warnings.push(m) });
    expect(await failing("/bin/sh", env)).toBeNull();
    expect(await createCodexFeatureLister(run)("/no/such/codex", env)).toBeNull();
  });

  it("concurrent callers share one version read and one listing", async () => {
    let versionRuns = 0;
    let listRuns = 0;
    const run: ProcessRunner = async (spec) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (spec.args[0] === "--version") {
        versionRuns += 1;
        return { stdout: "codex-cli 9.9.9\n", stderr: "", exitCode: 0 };
      }
      listRuns += 1;
      return { stdout: LISTING, stderr: "", exitCode: 0 };
    };
    const lister = createCodexFeatureLister(run);
    const env = { PATH: "/usr/bin:/bin" };
    const results = await Promise.all([lister("/bin/sh", env), lister("/bin/sh", env), lister("/bin/sh", env), lister("/bin/sh", env)]);
    for (const result of results) expect(result).toEqual(["apps", "agent_message_board", "shell_tool"]);
    expect(versionRuns).toBe(1);
    expect(listRuns).toBe(1);
  });

  it("logs a warning once when the listing cannot be read (the fallback blocklist applies), and tries again later", async () => {
    const warnings: string[] = [];
    let fail = true;
    const run: ProcessRunner = async (spec) => {
      if (spec.args[0] === "--version") return { stdout: "codex-cli 9.9.9\n", stderr: "", exitCode: 0 };
      return fail ? { stdout: "", stderr: "boom", exitCode: 1 } : { stdout: LISTING, stderr: "", exitCode: 0 };
    };
    const lister = createCodexFeatureLister(run, { onFallback: (m) => warnings.push(m) });
    const env = { PATH: "/usr/bin:/bin" };
    expect(await lister("/bin/sh", env)).toBeNull();
    expect(await lister("/bin/sh", env)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("codex features list");
    expect(warnings[0]).toContain("built-in list");
    fail = false; // a failure is not cached: the next call reads the listing
    expect(await lister("/bin/sh", env)).toEqual(["apps", "agent_message_board", "shell_tool"]);

    const noVersion = createCodexFeatureLister(async () => ({ stdout: "garbage", stderr: "", exitCode: 0 }), { onFallback: (m) => warnings.push(m) });
    expect(await noVersion("/bin/sh", env)).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("Codex version");
  });

  it("a provider with a listing switches off every listed feature that is not benign", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (spec) => {
      calls.push([...spec.args]);
      return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":\\"ok\\"}"}}\n', stderr: "", exitCode: 0 };
    };
    const codex = createCodexCliProvider({
      config: ai.providers.codex_cli,
      env: {},
      runProcess: run,
      findExecutable: () => "/bin/codex",
      authFileExists: () => true,
      listFeatures: async () => ["brand_new_tool", "fast_mode"],
    });
    await codex.run("score", prompt, schema);
    const c = valuesAfter(calls[0]!, "-c");
    expect(c).toContain("features.brand_new_tool=false");
    expect(c).not.toContain("features.fast_mode=false");
  });
});
