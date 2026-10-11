/**
 * The one place the AI tasks get their JD from: scoring, the signals review, the translation, the breakdown and the weekly
 * suggestions call `cleanDescriptionsForAi` right before they build a prompt. It loads the stored findings of the jobs and returns
 * `jdForAi` of each JD; a job without findings gets its very own string back. Never throws: when the findings cannot be read (the
 * tables are not migrated yet, a database hiccup, an unreadable traps.yaml) the JD goes out as before and a warning is logged.
 */
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig } from "@/lib/config";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { Executor } from "@/lib/db/executor";
import { loadTrapSpanRows, trapScanIsCurrent } from "@/lib/db/repos/traps";

import { jdForAi, resolveSpans } from "./ai-input";
import { rulesFingerprint } from "./fingerprint";
import { readTrapsSettings } from "./settings";
import type { TrapSpan } from "./types";

export interface CleanOptions {
  /** Default: traps.yaml (null = unreadable, nothing is cleaned). */
  settings?: TrapsConfig | null;
  logger?: Pick<ChannelLogger, "warn">;
}

export interface JobText {
  jobId: number;
  description: string | null;
}

/** The trap spans of the given jobs' JDs (empty for a job without findings, and for all jobs when the feature is off). */
export async function loadTrapSpans(db: Executor, jobs: readonly JobText[], options: CleanOptions = {}): Promise<Map<number, TrapSpan[]>> {
  const out = new Map<number, TrapSpan[]>();
  const settings = options.settings === undefined ? safeSettings(options.logger) : options.settings;
  if (!settings?.enabled) return out;
  const withText = jobs.filter((job) => job.description !== null && job.description !== "");
  if (withText.length === 0) return out;
  let rows;
  try {
    rows = await loadTrapSpanRows(db, withText.map((job) => job.jobId));
  } catch (error) {
    options.logger?.warn("ai trap findings could not be read; the JD goes to the AI uncleaned", { error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown error" });
    return out;
  }
  for (const job of withText) {
    const jobRows = rows.get(job.jobId);
    if (!jobRows || jobRows.length === 0) continue;
    const spans = resolveSpans(job.description as string, jobRows);
    if (spans.length > 0) out.set(job.jobId, spans);
  }
  return out;
}

function safeSettings(logger: CleanOptions["logger"]): TrapsConfig | null {
  try {
    return readTrapsSettings();
  } catch (error) {
    logger?.warn("traps.yaml could not be read; the JD goes to the AI uncleaned", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown error" });
    return null;
  }
}

/** Each job's JD as an AI may read it (`jdForAi`); a job without findings (or a null JD) maps to its own value. */
export async function cleanDescriptionsForAi(db: Executor, jobs: readonly JobText[], options: CleanOptions = {}): Promise<Map<number, string | null>> {
  const settings = options.settings === undefined ? safeSettings(options.logger) : options.settings;
  const spans = await loadTrapSpans(db, jobs, { ...options, settings });
  const out = new Map<number, string | null>();
  for (const job of jobs) {
    const jobSpans = spans.get(job.jobId);
    out.set(job.jobId, job.description !== null && jobSpans && settings ? jdForAi(job.description, jobSpans, { hidden: settings.ai_input.hidden_marker, instruction: settings.ai_input.instruction_marker }) : job.description);
  }
  return out;
}

/** One job's JD as an AI may read it. */
export async function cleanDescriptionForAi(db: Executor, job: JobText, options: CleanOptions = {}): Promise<string | null> {
  return (await cleanDescriptionsForAi(db, [job], options)).get(job.jobId) ?? job.description;
}

/** Why `cleanDescriptionStrict` gives no JD: the check is off, traps.yaml cannot be read, the job's scan is missing or outdated, the findings cannot be read. */
export type StrictCleanFailure = "traps_disabled" | "settings_unreadable" | "not_scanned" | "findings_unreadable";

export type StrictCleanResult =
  | {
      ok: true;
      /** The JD as an AI may read it (`jdForAi`); null when the job has none. */
      text: string | null;
      /** Pieces of the JD that were removed or replaced (0: the JD is the original). */
      removed: number;
      markers: { hidden: string; instruction: string };
    }
  | { ok: false; reason: StrictCleanFailure };

/**
 * The fail-closed variant of `cleanDescriptionForAi`, for a reader that is itself an AI and gets the JD on demand (the MCP server):
 * the JD is given only when trap detection is on, traps.yaml can be read, the job's scan is current under today's rules (same JD,
 * same source payloads, same rule fingerprint) and its findings can be read. Anything else is a failure with its reason, never
 * the uncleaned JD. `settings` is a loader for tests; it may throw.
 */
export async function cleanDescriptionStrict(db: Executor, job: JobText, options: { settings?: () => TrapsConfig } = {}): Promise<StrictCleanResult> {
  let settings: TrapsConfig;
  try {
    settings = (options.settings ?? (() => loadConfig("traps")))();
  } catch {
    return { ok: false, reason: "settings_unreadable" };
  }
  if (!settings.enabled) return { ok: false, reason: "traps_disabled" };
  let spans;
  try {
    if (!(await trapScanIsCurrent(db, job.jobId, rulesFingerprint(settings)))) return { ok: false, reason: "not_scanned" };
    spans = await loadTrapSpansStrict(db, job);
  } catch {
    return { ok: false, reason: "findings_unreadable" };
  }
  const markers = { hidden: settings.ai_input.hidden_marker, instruction: settings.ai_input.instruction_marker };
  if (job.description === null) return { ok: true, text: null, removed: 0, markers };
  return { ok: true, text: jdForAi(job.description, spans, markers), removed: spans.length, markers };
}

/** The trap spans of one JD; unlike `loadTrapSpans` a read error is thrown, not swallowed. */
export async function loadTrapSpansStrict(db: Executor, job: JobText): Promise<TrapSpan[]> {
  if (job.description === null || job.description === "") return [];
  const rows = await loadTrapSpanRows(db, [job.jobId]);
  return resolveSpans(job.description, rows.get(job.jobId) ?? []);
}
