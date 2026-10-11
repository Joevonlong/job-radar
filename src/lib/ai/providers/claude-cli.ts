import { z } from "zod";

import type { ChannelLogger } from "@/lib/channels/types";
import type { AiConfig } from "@/lib/config";

import { AiProviderError, QUOTA_PATTERN, registerSecret } from "../errors";
import { createProvider } from "../provider";
import type { AiAvailability, AiProvider, AiTokenUsage, AiTransport, AiTransportRequest, AiTransportResponse, JsonSchemaObject } from "../types";
import { safeDomains, webAccessAllowed } from "../web-tasks";
import { cliCommandProblem, cliModelProblem } from "./cli-guards";
import { claudeOutputShape } from "./output-shape";
import { childEnv, findExecutable, makeScratchDir, processFailure, runProcess, type ProcessRunner } from "./process";

/**
 * claude-cli: the user's Claude Code subscription through `claude -p`.
 *
 * Verified against `claude` 2.1.288 (`claude -p --help`). Command line (prompt on stdin):
 *
 *   claude -p --output-format json --json-schema '<schema>' --tools "" --strict-mcp-config --no-session-persistence
 *          --safe-mode --model <model> --system-prompt '<system>'
 *
 * - `--output-format json`: one JSON result envelope on stdout (`result`, `structured_output`, `usage`, `is_error`).
 * - `--json-schema`: structured output, delivered in `structured_output`.
 * - `--tools ""`: no tools at all (an allowlist of none: no shell, no file access, no web), the model can only answer.
 * - `--strict-mcp-config`: no MCP server from any settings file (none is passed with `--mcp-config`).
 * - `--no-session-persistence`: nothing written to ~/.claude/projects.
 * - `--safe-mode`: no CLAUDE.md, hooks, plugins, MCP servers or skills are loaded (a clean, fast, deterministic call).
 * - `--system-prompt`: replaces the default Claude Code system prompt with the task's own.
 * There is no `--max-turns` in this version, and none is needed with tools disabled.
 *
 * The one exception (`web-tasks.ts`: only a task in `WEB_ACCESS_TASKS`, checked here, never chosen by ai.yaml):
 *   `--tools "WebSearch,WebFetch" --allowedTools WebSearch "WebFetch(domain:<d>)" ... --permission-mode dontAsk`
 * instead of `--tools ""`, everything else unchanged. Verified against `claude` 2.1.296 under `-p`: `--tools` is the
 * whole tool set (no Bash, Read, Write, MCP); `--allowedTools` pre-approves WebSearch and WebFetch for the listed host
 * names (exact host: `levels.fyi` does not cover `www.levels.fyi`, so both are listed); `dontAsk` denies every call that is
 * not pre-approved (a fetch of another host shows up in the envelope's `permission_denials`). This is the CLI's own
 * permission check, not a network boundary, and WebSearch itself has no domain limit. Without a verified CLI version the
 * web task fails closed (`CLAUDE_WEB_MIN_VERSION`).
 * Runs in a fresh empty temp directory. Auth: `CLAUDE_CODE_OAUTH_TOKEN` (containers) or the host login.
 * `command` must be the `claude` executable (`cliCommandProblem`); any other program is never started. Model names are
 * checked too (`cliModelProblem`).
 */
export type ClaudeCliConfig = AiConfig["providers"]["claude_cli"];

export interface ClaudeCliOptions {
  config: ClaudeCliConfig;
  env?: Record<string, string | undefined>;
  runProcess?: ProcessRunner;
  /** Overridable for tests: where is the CLI? Default: look it up on PATH. */
  findExecutable?: (command: string, env: Record<string, string | undefined>) => string | null;
  /** The installed version (the output of `claude --version`), read only before a web task; null = unknown. */
  readVersion?: (command: string, env: Record<string, string | undefined>) => Promise<string | null>;
  /** Gets the key names of every reply envelope at debug level (passive check for a usage-limit field; no values). */
  logger?: Pick<ChannelLogger, "debug">;
}

/** `2.1.296 (Claude Code)` -> `2.1.296`. */
export function parseClaudeVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Whether version `a` is at least `b` (dotted numbers). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The oldest `claude` the web-task arguments were verified with; an older or unreadable version fails the web task. */
export const CLAUDE_WEB_MIN_VERSION = "2.1.296";

/**
 * Settings files a web task reads: only the project's, i.e. none (the call runs in an empty temporary directory).
 * `--safe-mode` still applies the user's `permissions.allow` from ~/.claude/settings.json, so a user rule such as
 * "WebFetch" would widen the fetches; `--setting-sources project` (documented in `claude --help`, 2.1.296) drops the user
 * and local files. Admin-managed settings still apply.
 */
export const CLAUDE_WEB_SETTING_SOURCES = ["--setting-sources", "project"] as const;

/** The web tools of a web task: WebSearch always, WebFetch only for the given host names (each also with `www.`). */
export function claudeWebToolArgs(domains: readonly string[]): string[] {
  const hosts = safeDomains(domains).flatMap((domain) => (domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`]));
  const unique = [...new Set(hosts)];
  if (unique.length === 0) return ["--tools", "WebSearch", "--allowedTools", "WebSearch", "--permission-mode", "dontAsk", ...CLAUDE_WEB_SETTING_SOURCES];
  return ["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch", ...unique.map((host) => `WebFetch(domain:${host})`), "--permission-mode", "dontAsk", ...CLAUDE_WEB_SETTING_SOURCES];
}

/**
 * `web`: the host names of a web task (the caller has checked `webAccessAllowed`); absent = no tools at all, the
 * argument list every other task gets, unchanged.
 */
export function claudeArgs(model: string, system: string, jsonSchema: JsonSchemaObject, web?: { domains: readonly string[] }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(jsonSchema),
    ...(web ? claudeWebToolArgs(web.domains) : ["--tools", ""]),
    "--strict-mcp-config",
    "--no-session-persistence",
    "--safe-mode",
    "--model",
    model,
    "--system-prompt",
    system,
  ];
}

const tokenCount = z.number().int().nonnegative().optional();
const envelopeSchema = z.looseObject({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  api_error_status: z.number().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      output_tokens_details: z.looseObject({ thinking_tokens: tokenCount }).optional(),
      cache_creation_input_tokens: tokenCount.nullable(),
      cache_read_input_tokens: tokenCount.nullable(),
    })
    .optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

export interface ClaudeOutput {
  /** The answer as JSON text (from `structured_output`, else the `result` text). */
  text: string;
  /** The model that answered, when the CLI reports it. */
  model: string | null;
  usage: AiTokenUsage;
}

function classifyError(message: string, status: number | null | undefined): AiProviderError["kind"] {
  if (status === 401 || status === 403 || /log ?in|authenticat|oauth|unauthori[sz]ed|credential/i.test(message)) return "auth";
  if (status === 429 || QUOTA_PATTERN.test(message)) return "rate_limited";
  return "provider_error";
}

/** Parse the stdout of `claude -p --output-format json`. Throws `AiProviderError` for error results. */
export function parseClaudeOutput(stdout: string): ClaudeOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new AiProviderError("claude-cli", "provider_error", "output is not a JSON envelope");
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new AiProviderError("claude-cli", "provider_error", "unexpected output envelope");
  const envelope = parsed.data;
  if (envelope.is_error === true) {
    const message = envelope.result ?? "error result without a message";
    throw new AiProviderError("claude-cli", classifyError(message, envelope.api_error_status), message);
  }
  const usage = envelope.usage;
  const reported = usage?.input_tokens !== undefined && usage.output_tokens !== undefined;
  const text =
    envelope.structured_output !== undefined && envelope.structured_output !== null
      ? JSON.stringify(envelope.structured_output)
      : (envelope.result ?? "");
  if (text.trim() === "") throw new AiProviderError("claude-cli", "invalid_output", "empty result");
  return {
    text,
    model: Object.keys(envelope.modelUsage ?? {})[0] ?? null,
    usage: reported
      ? {
          tokensIn: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
          tokensOut: usage?.output_tokens ?? 0,
          cachedIn: usage?.cache_read_input_tokens ?? 0,
          cacheWriteIn: usage?.cache_creation_input_tokens ?? 0,
          ...(usage?.output_tokens_details?.thinking_tokens !== undefined ? { reasoningOut: usage.output_tokens_details.thinking_tokens } : {}),
        }
      : { tokensIn: 0, tokensOut: 0, reported: false },
  };
}

export function createClaudeCliTransport(options: ClaudeCliOptions): AiTransport {
  const env = options.env ?? process.env;
  const run = options.runProcess ?? runProcess;
  const locate = options.findExecutable ?? findExecutable;
  const { config } = options;
  registerSecret(env.CLAUDE_CODE_OAUTH_TOKEN);
  const versions = new Map<string, string | null>();
  const readVersion =
    options.readVersion ??
    (async (command: string): Promise<string | null> => {
      if (versions.has(command)) return versions.get(command) ?? null;
      const scratch = makeScratchDir("jr-claude-version");
      try {
        const result = await run({ command, args: ["--version"], stdin: "", cwd: scratch.dir, env: childEnv(env, []), timeoutMs: 10_000 });
        const version = result.exitCode === 0 ? parseClaudeVersion(result.stdout) : null;
        // only a version that was read is kept: a transient failure (non-zero exit, timeout) is asked again next time
        if (version !== null) versions.set(command, version);
        return version;
      } catch {
        return null;
      } finally {
        scratch.cleanup();
      }
    });
  return {
    id: "claude-cli",
    availability(): AiAvailability {
      const refused = cliCommandProblem("claude-cli", config.command) ?? cliModelProblem("claude-cli", config.model) ?? cliModelProblem("claude-cli", config.strong_model);
      if (refused !== null) return { available: false, reason: refused };
      return locate(config.command, env) === null
        ? { available: false, reason: `"${config.command}" not found on PATH` }
        : { available: true };
    },
    plannedModel: (request) => request.model ?? (request.strong ? config.strong_model : config.model),
    async call(request: AiTransportRequest): Promise<AiTransportResponse> {
      const model = request.model ?? (request.strong ? config.strong_model : config.model);
      const refused = cliCommandProblem("claude-cli", config.command) ?? cliModelProblem("claude-cli", model);
      if (refused !== null) throw new AiProviderError("claude-cli", "not_configured", refused);
      // Web tools only for a web task (the policy decides, not the request); such a call needs a verified CLI version
      const web = webAccessAllowed(request.task, "claude-cli") ? { domains: request.web?.allowedDomains ?? [] } : undefined;
      if (web) {
        const output = await readVersion(config.command, env);
        const version = output === null ? null : parseClaudeVersion(output);
        if (version === null || !versionAtLeast(version, CLAUDE_WEB_MIN_VERSION)) {
          throw new AiProviderError("claude-cli", "not_configured", `web search needs claude ${CLAUDE_WEB_MIN_VERSION} or newer (found ${version ?? "unknown"})`);
        }
      }
      const scratch = makeScratchDir("jr-claude");
      try {
        let result;
        try {
          result = await run({
            command: config.command,
            args: claudeArgs(model, request.system, request.jsonSchema, web),
            stdin: request.user,
            cwd: scratch.dir,
            env: childEnv(env, ["CLAUDE_CODE_OAUTH_TOKEN"]),
            timeoutMs: request.timeoutMs ?? config.timeout_seconds * 1000,
            ...(request.signal ? { signal: request.signal } : {}),
          });
        } catch (error) {
          throw processFailure("claude-cli", config.command, error);
        }
        if (result.stdout.trim() === "") {
          throw new AiProviderError("claude-cli", "provider_error", `exit code ${result.exitCode ?? "signal"}: ${result.stderr || "no output"}`);
        }
        const shape = options.logger ? claudeOutputShape(result.stdout) : null;
        if (shape) options.logger?.debug("claude-cli output shape", { ...shape });
        const output = parseClaudeOutput(result.stdout);
        return { text: output.text, model: output.model ?? model, usage: output.usage };
      } finally {
        scratch.cleanup();
      }
    },
  };
}

export function createClaudeCliProvider(options: ClaudeCliOptions): AiProvider {
  return createProvider(createClaudeCliTransport(options));
}
