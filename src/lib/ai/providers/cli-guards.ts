import path from "node:path";

/**
 * Checks the ai-worker applies to the subscription-CLI settings of ai.yaml before it runs anything. The file is
 * editable from the web UI, so the worker does not trust it: whatever the file says, a CLI call keeps its tools off and
 * only the CLI itself is ever started (defence in depth, independent of what the web side allows).
 */

/**
 * Codex features left on: they change how the client talks to the API, not what the model may do. Every other
 * feature `codex features list` names is switched off on every call (`-c features.<name>=false`): an allowlist, so a
 * feature a new Codex version adds is off until it is reviewed here.
 */
const CODEX_BENIGN_FEATURES = new Set([
  "enable_request_compression",
  "content_item_kinds",
  "compaction_image_budget",
  "unbounded_connection_retries",
  "fast_mode",
  "api_key_model_discovery",
  "auth_elicitation",
  // the approval reviewer: with approval_policy "never" and a read-only sandbox it has nothing to review; named one by one,
  // not by prefix, so a future guardian_* feature is off until it is looked at
  "guardian_approval",
  "guardian_reuse_parent_compaction",
]);

export function isBenignCodexFeature(name: string): boolean {
  return CODEX_BENIGN_FEATURES.has(name);
}

/**
 * Switched off on every call in any case, and the whole list when `codex features list` cannot be read: everything that
 * would let the model run commands, reach the network, the browser or the desktop, load extensions or MCP servers, ask
 * for permissions or keep state. ai.yaml `disable_features` can only add to it. `--sandbox read-only` stays the backstop.
 */
export const CODEX_FEATURES_FALLBACK_OFF = [
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "write_stdin_approval",
  "shell_snapshot",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "apps",
  "memories",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "browser_annotation_api",
  "computer_use",
  "in_app_browser",
  "in_app_chat",
  "in_app_local_automation",
  "view_image",
  "tool_suggest",
  "tool_call_mcp_elicitation",
  "skill_search",
  "skill_mcp_dependency_install",
  "goals",
  "sleep_tool",
  "hooks",
  "code_mode",
  "code_mode_host",
  "workspace_dependencies",
  "worktrees",
  "mentions_v2",
  "realtime_conversation",
  "daemon_auto_start",
  "standalone_web_search",
  "request_permissions_tool",
  "network_proxy",
] as const;

/**
 * The features a codex call switches off: every listed feature that is not benign (`listed`: the names `codex features
 * list` printed, null when it could not be read), plus the fallback list and ai.yaml's own, without duplicates.
 */
export function codexFeaturesOff(listed: readonly string[] | null, configured: readonly string[]): string[] {
  const fromList = (listed ?? []).filter((name) => !isBenignCodexFeature(name));
  return [...new Set<string>([...fromList, ...CODEX_FEATURES_FALLBACK_OFF, ...configured])];
}

/**
 * Codex config values always set, after every other `-c` (so nothing in ai.yaml can undo them): no web search, no
 * apply-patch or image tool, and never an approval prompt (with the read-only sandbox nothing can be escalated).
 */
export const CODEX_ENFORCED_CONFIG: Readonly<Record<string, string>> = {
  web_search: '"disabled"',
  include_apply_patch_tool: "false",
  "tools.view_image": "false",
  approval_policy: '"never"',
};

/**
 * `codex_cli.config_overrides` keys the worker passes on, and only with the value `false`: switches that trim Codex's
 * context. Anything else (`mcp_servers.*`, `model_provider*`, `sandbox*`, `approval*`, `shell_environment_policy*`,
 * `profile*`, `features.*`, ...) could start processes, send the prompt or the login elsewhere or widen the sandbox, and
 * is dropped with a warning. `web_search` is enforced (`CODEX_ENFORCED_CONFIG`), so it is left out without a warning.
 */
const CODEX_OVERRIDE_KEYS = new Set(["skills.include_instructions", "agents.enabled"]);
/** `include_permissions_instructions`, `include_environment_context`, ...: Codex's switches for its context sections. */
const CODEX_INCLUDE_KEY = /^include_[a-z0-9_]+_(instructions|context)$/;
const SILENTLY_ENFORCED_KEYS = new Set(["web_search"]);

export function isAllowedCodexOverride(key: string, value: string): boolean {
  return (CODEX_OVERRIDE_KEYS.has(key) || CODEX_INCLUDE_KEY.test(key)) && value.trim() === "false";
}

export interface FilteredOverrides {
  kept: Record<string, string>;
  /** Keys left out, in file order (not counting the silently enforced ones). */
  dropped: string[];
}

export function filterCodexOverrides(overrides: Readonly<Record<string, string>>): FilteredOverrides {
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (isAllowedCodexOverride(key, value)) kept[key] = "false";
    else if (!SILENTLY_ENFORCED_KEYS.has(key)) dropped.push(key);
  }
  return { kept, dropped };
}

/** The executable each subscription CLI provider may start. */
export const CLI_COMMAND_NAMES = { "claude-cli": "claude", "codex-cli": "codex" } as const;
export type CliProviderId = keyof typeof CLI_COMMAND_NAMES;

const configKey = (provider: CliProviderId): string => `providers.${provider.replace("-", "_")}`;

/**
 * Why `command` is refused for `provider`, or null when it is fine: the bare name (`claude`, looked up on PATH) or an
 * absolute path whose file name is the CLI's own (`/opt/homebrew/bin/claude`; on Windows also `.exe` / `.cmd`).
 * Relative paths and any other program are never started.
 */
export function cliCommandProblem(provider: CliProviderId, command: string): string | null {
  const expected = CLI_COMMAND_NAMES[provider];
  const base = path.basename(command).replace(/\.(exe|cmd)$/i, "");
  const bare = command === base || command.toLowerCase() === `${expected}.exe` || command.toLowerCase() === `${expected}.cmd`;
  if (base === expected && command.trim() === command && (bare || path.isAbsolute(command))) return null;
  return `ai.yaml ${configKey(provider)}.command must be "${expected}" or an absolute path ending in /${expected}; "${command}" is not started`;
}

/** A model name passed to `--model` / `-m`: letters, digits and `._:/[]-`, not starting with a dash (never an option). */
const MODEL_NAME = /^[A-Za-z0-9._:/[\]][A-Za-z0-9._:/[\]-]*$/;

/** Why `model` is refused as a CLI model name, or null when it is fine. */
export function cliModelProblem(provider: CliProviderId, model: string): string | null {
  if (MODEL_NAME.test(model)) return null;
  return `ai.yaml ${configKey(provider)}: model "${model}" is not a valid model name (letters, digits and ._:/[]- only, not starting with -)`;
}
