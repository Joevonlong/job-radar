import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { ChannelLogger } from "@/lib/channels/types";
import type { AiConfig } from "@/lib/config";

import { AiProviderError, QUOTA_PATTERN } from "../errors";
import { createProvider } from "../provider";
import type { AiAvailability, AiProvider, AiTask, AiTokenUsage, AiTransport, AiTransportRequest, AiTransportResponse } from "../types";
import { webAccessAllowed } from "../web-tasks";
import { CODEX_ENFORCED_CONFIG, cliCommandProblem, cliModelProblem, codexFeaturesOff, filterCodexOverrides } from "./cli-guards";
import { defaultCodexFeatureLister, type CodexFeatureLister } from "./codex-features";
import { codexOutputShape } from "./output-shape";
import { Semaphore } from "./semaphore";
import { childEnv, findExecutable, makeScratchDir, processFailure, runProcess, type ProcessRunner } from "./process";

/**
 * codex-cli: the user's Codex (ChatGPT) subscription through `codex exec`.
 *
 * Verified against `codex-cli` 0.162.0 (`codex exec --help`, `codex features list`; ai.yaml `verified_version`). Command line (prompt on stdin via `-`):
 *
 *   codex exec --json --output-schema <dir>/schema.json --sandbox read-only --skip-git-repo-check
 *              --ephemeral --ignore-user-config --ignore-rules --color never -C <dir>
 *              [-m <model>] -c model_reasoning_effort="<effort>"
 *              [trim_context: -c model_instructions_file="<dir>/instructions.md" -c <config_overrides key>=<value> ...]
 *              -c features.<name>=false ... -c web_search="disabled" -
 *
 * - `--json`: JSONL events on stdout; the answer is the last `agent_message` item, tokens come from `turn.completed`.
 * - `--output-schema`: JSON Schema file constraining the final message.
 * - `--sandbox read-only`: even if the model tried a shell command it could not write anything.
 * - `--skip-git-repo-check`, `-C <empty temp dir>`: runs outside any repository.
 * - `--ephemeral`: no session files; `--ignore-user-config`, `--ignore-rules`: a deterministic call that does
 *   not depend on ~/.codex/config.toml (auth still comes from CODEX_HOME / ~/.codex/auth.json).
 * - Tools are off on every call, with or without trim_context: every feature `codex features list` names except a short
 *   benign allowlist, plus the fixed fallback list and ai.yaml `disable_features`, as `-c features.<name>=false` (an
 *   unknown name is ignored, unlike `--disable`); then web search off, no apply-patch / image tool, approval "never"
 *   (`CODEX_ENFORCED_CONFIG`). These come last, so no earlier `-c` can switch a tool back on.
 * - G0 (trim_context): the task's system prompt becomes Codex's base instructions (`model_instructions_file`), the
 *   skills list and environment text are switched off with `config_overrides` (only allowlisted keys, see
 *   `filterCodexOverrides`), and stdin carries the user prompt only. trim_context=false: system + user on stdin, Codex's
 *   default context (still without tools).
 * - `command` must be the `codex` executable (`cliCommandProblem`); any other program is never started. The model name
 *   is checked too (`cliModelProblem`).
 * - G8: `-m` only when ai.yaml sets `providers.codex_cli.model` (else the CLI's built-in default); reasoning effort always explicit.
 * - G7: at most `max_concurrency` calls at once per process; one retry after a first `auth` failure.
 * - The one exception (`web-tasks.ts`, a task in `WEB_ACCESS_TASKS` only): `-c web_search="live"` instead of
 *   "disabled"; every feature stays off as above (`standalone_web_search` too). Codex's web search cannot be limited to
 *   domains. When `codex features list` cannot be read the web task fails (no fallback list for it).
 */
/** What `AiTransportResponse.model` says when codex was not told a model: the catalog's `cli_default` entry names it (router). */
export const CODEX_DEFAULT_MODEL = "codex-default";

export type CodexCliConfig = AiConfig["providers"]["codex_cli"];

export interface CodexCliOptions {
  config: CodexCliConfig;
  env?: Record<string, string | undefined>;
  runProcess?: ProcessRunner;
  /** Overridable for tests: where is the CLI? Default: look it up on PATH. */
  findExecutable?: (command: string, env: Record<string, string | undefined>) => string | null;
  /** Overridable for tests: does the auth file exist? */
  authFileExists?: (file: string) => boolean;
  /** Overridable for tests: the wait before the auth retry. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Overridable for tests: the concurrency gate (default: one shared by the whole process). */
  semaphore?: Semaphore;
  /**
   * The installed Codex's feature names (`codex features list`). Default: the real listing, unless `runProcess` is
   * injected (tests), then none (the fixed fallback list applies).
   */
  listFeatures?: CodexFeatureLister;
  /** Gets the event / key names of every reply at debug level (passive check for a usage-limit field; no values). */
  logger?: Pick<ChannelLogger, "debug">;
}

/** A TOML basic string (JSON string syntax is a subset of it), so any path or text is quoted safely. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export interface CodexArgsOptions {
  schemaFile: string;
  cwd: string;
  model?: string | undefined;
  reasoningEffort: string;
  /** Set with trim_context: the file holding the system prompt. */
  instructionsFile?: string | undefined;
  /** ai.yaml `disable_features`: added to the features switched off on every call. */
  disableFeatures?: readonly string[];
  /** The installed Codex's feature names; every one not on the benign allowlist is switched off. null/absent: fallback list only. */
  listedFeatures?: readonly string[] | null;
  /** Passed with trim_context only, and only the allowlisted keys (`filterCodexOverrides`). */
  configOverrides?: Readonly<Record<string, string>>;
  /** A web task (`webAccessAllowed` checked by the caller): `web_search="live"`, nothing else changes. */
  webSearch?: boolean;
}

/** The enforced config of a call: `CODEX_ENFORCED_CONFIG`, with live web search for a web task only. */
export function codexEnforcedConfig(webSearch: boolean): Readonly<Record<string, string>> {
  return webSearch ? { ...CODEX_ENFORCED_CONFIG, web_search: '"live"' } : CODEX_ENFORCED_CONFIG;
}

export function codexArgs(options: CodexArgsOptions): string[] {
  const args = [
    "exec",
    "--json",
    "--output-schema",
    options.schemaFile,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-C",
    options.cwd,
  ];
  if (options.model) args.push("-m", options.model);
  args.push("-c", `model_reasoning_effort=${tomlString(options.reasoningEffort)}`);
  if (options.instructionsFile !== undefined) {
    args.push("-c", `model_instructions_file=${tomlString(options.instructionsFile)}`);
    for (const [key, value] of Object.entries(filterCodexOverrides(options.configOverrides ?? {}).kept)) args.push("-c", `${key}=${value}`);
  }
  // Tool restrictions: independent of trim_context and last, so an earlier `-c` cannot undo them (Codex: the last value wins).
  for (const name of codexFeaturesOff(options.listedFeatures ?? null, options.disableFeatures ?? [])) args.push("-c", `features.${name}=false`);
  for (const [key, value] of Object.entries(codexEnforcedConfig(options.webSearch === true))) args.push("-c", `${key}=${value}`);
  args.push("-");
  return args;
}

/** Process-wide cap shared by every codex-cli provider instance (G7). */
const processSemaphore = new Semaphore(3);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiProviderError("codex-cli", "aborted", "cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AiProviderError("codex-cli", "aborted", "cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function codexEffort(config: CodexCliConfig, task: AiTask): string {
  return config.reasoning_effort_by_task[task] ?? config.reasoning_effort;
}

const tokenCount = z.number().int().nonnegative().optional();
const eventSchema = z.looseObject({
  type: z.string(),
  item: z.looseObject({ type: z.string().optional(), text: z.string().optional(), message: z.string().optional() }).optional(),
  usage: z
    .looseObject({ input_tokens: tokenCount, cached_input_tokens: tokenCount, cache_write_input_tokens: tokenCount, output_tokens: tokenCount, reasoning_output_tokens: tokenCount })
    .optional(),
  message: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

export interface CodexOutput {
  text: string;
  usage: AiTokenUsage;
}

/** The `message` of a failure event is often itself a JSON document ({"status":400,"error":{"message":..}}). */
function failureText(message: string): { text: string; status: number | null } {
  try {
    const inner = z
      .looseObject({ status: z.number().optional(), error: z.looseObject({ message: z.string().optional() }).optional() })
      .parse(JSON.parse(message));
    return { text: inner.error?.message ?? message, status: inner.status ?? null };
  } catch {
    return { text: message, status: null };
  }
}

function classifyError(text: string, status: number | null): AiProviderError["kind"] {
  if (status === 401 || status === 403 || /log ?in|unauthori[sz]ed|authenticat|auth\.json|token.*(expired|invalid)/i.test(text)) return "auth";
  if (status === 429 || QUOTA_PATTERN.test(text)) return "rate_limited";
  return "provider_error";
}

/** Parse the JSONL stdout of `codex exec --json`. Throws `AiProviderError` when the turn failed. */
export function parseCodexOutput(stdout: string): CodexOutput {
  let text: string | null = null;
  let usage: AiTokenUsage = { tokensIn: 0, tokensOut: 0, reported: false };
  let failure: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text !== undefined) {
      text = event.item.text;
    } else if (event.type === "turn.completed" && event.usage) {
      // `output_tokens` already includes the reasoning tokens.
      usage =
        event.usage.input_tokens === undefined || event.usage.output_tokens === undefined
          ? { tokensIn: 0, tokensOut: 0, reported: false }
          : {
              tokensIn: event.usage.input_tokens,
              tokensOut: event.usage.output_tokens,
              cachedIn: event.usage.cached_input_tokens ?? 0,
              cacheWriteIn: event.usage.cache_write_input_tokens ?? 0,
              reasoningOut: event.usage.reasoning_output_tokens ?? 0,
            };
    } else if (event.type === "turn.failed") {
      failure = event.error?.message ?? failure ?? "turn failed";
    } else if (event.type === "error" && failure === null) {
      failure = event.message ?? "error";
    }
  }
  if (failure !== null) {
    const { text: message, status } = failureText(failure);
    throw new AiProviderError("codex-cli", classifyError(message, status), message);
  }
  if (text === null || text.trim() === "") throw new AiProviderError("codex-cli", "invalid_output", "no agent message in the output");
  return { text, usage };
}

export function codexAuthFile(env: Record<string, string | undefined>): string {
  const home = env.CODEX_HOME && env.CODEX_HOME !== "" ? env.CODEX_HOME : path.join(env.HOME && env.HOME !== "" ? env.HOME : homedir(), ".codex");
  return path.join(home, "auth.json");
}

export function createCodexCliTransport(options: CodexCliOptions): AiTransport {
  const env = options.env ?? process.env;
  const run = options.runProcess ?? runProcess;
  const locate = options.findExecutable ?? findExecutable;
  const exists = options.authFileExists ?? existsSync;
  const listFeatures: CodexFeatureLister = options.listFeatures ?? (options.runProcess === undefined ? defaultCodexFeatureLister : async () => null);
  const { config } = options;
  return {
    id: "codex-cli",
    availability(): AiAvailability {
      const refused = cliCommandProblem("codex-cli", config.command) ?? (config.model === undefined ? null : cliModelProblem("codex-cli", config.model));
      if (refused !== null) return { available: false, reason: refused };
      if (locate(config.command, env) === null) return { available: false, reason: `"${config.command}" not found on PATH` };
      if (!exists(codexAuthFile(env))) return { available: false, reason: "no Codex login (~/.codex/auth.json missing)" };
      return { available: true };
    },
    plannedModel: (request) => request.model ?? config.model ?? CODEX_DEFAULT_MODEL,
    async call(request: AiTransportRequest): Promise<AiTransportResponse> {
      const model = request.model ?? config.model;
      const refused = cliCommandProblem("codex-cli", config.command) ?? (model === undefined ? null : cliModelProblem("codex-cli", model));
      if (refused !== null) throw new AiProviderError("codex-cli", "not_configured", refused);
      const sleep = options.sleep ?? defaultSleep;
      const gate = options.semaphore ?? processSemaphore;
      gate.limit = config.max_concurrency;
      const attempt = async (): Promise<CodexOutput> => {
        // The timeout starts with the process (inside `run`), not while this call waits for a slot.
        const release = await gate.acquire("codex-cli", request.signal);
        try {
          return await runOnce(request);
        } finally {
          release();
        }
      };
      let output: CodexOutput;
      try {
        output = await attempt();
      } catch (error) {
        // G7: concurrent processes share ~/.codex/auth.json; a token refresh race looks like an expired login. Retry once.
        if (!(error instanceof AiProviderError) || error.kind !== "auth" || config.auth_retry_seconds <= 0) throw error;
        await sleep(config.auth_retry_seconds * 1000, request.signal);
        output = await attempt();
      }
      return { text: output.text, model: request.model ?? config.model ?? CODEX_DEFAULT_MODEL, usage: output.usage };
    },
  };

  async function runOnce(request: AiTransportRequest): Promise<CodexOutput> {
    const scratch = makeScratchDir("jr-codex");
    try {
      const schemaFile = path.join(scratch.dir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(request.jsonSchema), "utf8");
      let instructionsFile: string | undefined;
      let prompt: string;
      if (config.trim_context) {
        instructionsFile = path.join(scratch.dir, "instructions.md");
        writeFileSync(instructionsFile, request.system, "utf8");
        prompt = request.user;
      } else {
        // codex exec has no system-prompt flag: the system text leads the prompt.
        prompt = `${request.system}\n\n${request.user}`;
      }
      const listedFeatures = await listFeatures(config.command, env);
      const webSearch = webAccessAllowed(request.task, "codex-cli");
      // Web search is only allowed when every listed feature can be switched off: no fallback list for a web task
      if (webSearch && listedFeatures === null) throw new AiProviderError("codex-cli", "not_configured", "web search needs a readable `codex features list`");
      let result;
      try {
        result = await run({
          command: config.command,
          args: codexArgs({
            listedFeatures,
            schemaFile,
            cwd: scratch.dir,
            model: request.model ?? config.model,
            reasoningEffort: codexEffort(config, request.task),
            instructionsFile,
            disableFeatures: config.disable_features,
            configOverrides: config.config_overrides,
            ...(webSearch ? { webSearch: true } : {}),
          }),
          stdin: prompt,
          cwd: scratch.dir,
          env: childEnv(env, ["CODEX_HOME"]),
          timeoutMs: request.timeoutMs ?? config.timeout_seconds * 1000,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        throw processFailure("codex-cli", config.command, error);
      }
      if (result.stdout.trim() === "") {
        throw new AiProviderError("codex-cli", "provider_error", `exit code ${result.exitCode ?? "signal"}: ${result.stderr || "no output"}`);
      }
      if (options.logger) options.logger.debug("codex-cli output shape", { ...codexOutputShape(result.stdout) });
      return parseCodexOutput(result.stdout);
    } finally {
      scratch.cleanup();
    }
  }
}

export function createCodexCliProvider(options: CodexCliOptions): AiProvider {
  return createProvider(createCodexCliTransport(options));
}
