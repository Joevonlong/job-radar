/**
 * The readiness list of the review step (and `pnpm run setup --status`): is there enough to run a useful cycle?
 * `buildReadiness` is pure; the loaders live in view.ts / the CLI.
 */
import type { ProfileScoringField } from "@/lib/scoring/profile";

export const READINESS_IDS = ["profile", "channels", "ai", "runner", "aiWorker"] as const;
export type ReadinessId = (typeof READINESS_IDS)[number];
export type ReadinessStatus = "ok" | "warn" | "fail";

export interface ReadinessItem {
  id: ReadinessId;
  status: ReadinessStatus;
  /** Message parameters (counts, names); never a secret. */
  params: Record<string, string | number>;
  /** `profile` only: the missing me.yaml fields (`summary`, `skills`); shown with their interface labels (`readinessParams`). */
  fields?: readonly ProfileScoringField[];
}

export interface ReadinessInput {
  /** Fields scoring still needs in me.yaml (`summary`, `skills`); null when me.yaml cannot be read. */
  profileMissing: readonly ProfileScoringField[] | null;
  /** Enabled channels of the current market, and those of them that lack an environment variable. */
  channels: { enabled: readonly string[]; missingEnv: readonly string[] } | null;
  /** Enabled AI providers, and the API ones of them whose key is not set. */
  ai: { enabled: readonly string[]; missingKey: readonly string[] } | null;
  /** Runner heartbeat; null when the database cannot be read. */
  runnerOnline: boolean | null;
  /** ai-worker heartbeat; `notNeeded` with `execution: container`; null when unknown. */
  aiWorker: "online" | "offline" | "notNeeded" | null;
}

export function buildReadiness(input: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];

  if (input.profileMissing === null) items.push({ id: "profile", status: "fail", params: { state: "unreadable" } });
  else if (input.profileMissing.length > 0) items.push({ id: "profile", status: "warn", params: { state: "missing" }, fields: input.profileMissing });
  else items.push({ id: "profile", status: "ok", params: { state: "ok" } });

  if (input.channels === null) items.push({ id: "channels", status: "fail", params: { state: "unreadable", count: 0 } });
  else {
    const usable = input.channels.enabled.filter((id) => !input.channels?.missingEnv.includes(id));
    if (usable.length === 0) items.push({ id: "channels", status: "fail", params: { state: "none", count: 0, missing: input.channels.missingEnv.join(", ") } });
    else if (input.channels.missingEnv.length > 0) items.push({ id: "channels", status: "warn", params: { state: "someMissing", count: usable.length, missing: input.channels.missingEnv.join(", ") } });
    else items.push({ id: "channels", status: "ok", params: { state: "ok", count: usable.length } });
  }

  if (input.ai === null) items.push({ id: "ai", status: "fail", params: { state: "unreadable", count: 0 } });
  else {
    // `on`: switched on in ai.yaml; `count`: of those, the ones that can run (an API provider needs its key)
    const usable = input.ai.enabled.filter((id) => !input.ai?.missingKey.includes(id));
    const counts = { on: input.ai.enabled.length, count: usable.length, missing: input.ai.missingKey.join(", ") };
    if (input.ai.enabled.length === 0) items.push({ id: "ai", status: "fail", params: { state: "none", ...counts } });
    else if (usable.length === 0) items.push({ id: "ai", status: "fail", params: { state: "noKey", ...counts } });
    else items.push({ id: "ai", status: input.ai.missingKey.length > 0 ? "warn" : "ok", params: { state: input.ai.missingKey.length > 0 ? "someMissing" : "ok", ...counts } });
  }

  items.push(input.runnerOnline === null ? { id: "runner", status: "warn", params: { state: "unknown" } } : { id: "runner", status: input.runnerOnline ? "ok" : "fail", params: { state: input.runnerOnline ? "online" : "offline" } });

  if (input.aiWorker === "notNeeded") items.push({ id: "aiWorker", status: "ok", params: { state: "notNeeded" } });
  else if (input.aiWorker === null) items.push({ id: "aiWorker", status: "warn", params: { state: "unknown" } });
  else items.push({ id: "aiWorker", status: input.aiWorker === "online" ? "ok" : "warn", params: { state: input.aiWorker } });

  return items;
}

/** The message parameters of a readiness line, with the missing profile fields as interface labels joined by `separator`. */
export function readinessParams(item: ReadinessItem, fieldLabel: (field: ProfileScoringField) => string, separator: string): Record<string, string | number> {
  return { state: "", count: 0, fields: (item.fields ?? []).map(fieldLabel).join(separator), missing: "", ...item.params };
}
