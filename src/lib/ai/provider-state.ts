/**
 * Whether an AI provider can take a request right now, as the web pages show it (health, dropdowns).
 * Pure: the inputs come from ai.yaml, the environment and the shared health rows (`runtime_state`).
 */
export const AI_PROVIDER_STATES = ["ready", "unconfigured", "off", "auth", "cooling", "capped"] as const;
export type AiProviderState = (typeof AI_PROVIDER_STATES)[number];

export interface AiProviderStateInput {
  /** false: an API provider without its key (the web process cannot see the host's CLIs: they count as configured). */
  configured: boolean;
  enabled: boolean;
  /** Set only while a cooldown is still running. */
  coolingUntil: Date | null;
  /** 0 = unlimited. */
  dailyCap: number;
  requestsToday: number;
  lastErrorKind: string | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
}

/** The newest outcome is a failure of `kinds` (a later success means it was fixed since). */
function failedLastWith(input: AiProviderStateInput, kinds: readonly string[]): boolean {
  if (input.lastErrorKind === null || input.lastErrorAt === null || !kinds.includes(input.lastErrorKind)) return false;
  return input.lastSuccessAt === null || input.lastErrorAt.getTime() > input.lastSuccessAt.getTime();
}

/**
 * `unconfigured`: no key, or the host reported the CLI missing; `off`: switched off in ai.yaml; `auth`: the last call
 * failed with a login error (not logged in / expired token); `cooling`: skipped after a quota error; `capped`: today's
 * `daily_request_cap` is used up; otherwise `ready`.
 */
export function aiProviderState(input: AiProviderStateInput): AiProviderState {
  if (!input.configured || failedLastWith(input, ["not_configured"])) return "unconfigured";
  if (!input.enabled) return "off";
  if (input.coolingUntil !== null) return "cooling";
  if (input.dailyCap > 0 && input.requestsToday >= input.dailyCap) return "capped";
  if (failedLastWith(input, ["auth"])) return "auth";
  return "ready";
}
