/**
 * The one place the AI tasks get their JD from: scoring, the signals review, the translation, the breakdown and the weekly
 * suggestions call `cleanDescriptionsForAi` right before they build a prompt. It loads the stored findings of the jobs and returns
 * `jdForAi` of each JD; a job without findings gets its very own string back. Never throws: when the findings cannot be read (the
 * tables are not migrated yet, a database hiccup, an unreadable traps.yaml) the JD goes out as before and a warning is logged.
 */
import type { ChannelLogger } from "@/lib/channels/types";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { Executor } from "@/lib/db/executor";
import { loadTrapSpanRows } from "@/lib/db/repos/traps";

import { jdForAi, resolveSpans } from "./ai-input";
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
