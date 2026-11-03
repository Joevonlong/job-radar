import { noopSpan } from "@/lib/activity";
import { registerAiSubtask, type AiSubtask, type AiSubtaskContext } from "@/lib/ai";
import { ConfigError, reloadConfig, type ResearchConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { listHighScoreResearchCandidates } from "@/lib/db/repos/research-auto-runs";

import { autoResearchDeps, requestAutoResearch, type AutoResearchDeps } from "./auto";

export const RESEARCH_SUBTASK_NAME = "research";

export interface ResearchSubtaskResult {
  /** Why nothing ran: off, not asked for, unreadable research.yaml, dry run, no database. */
  skipped?: "disabled" | "off" | "config_error" | "dry run" | "no database";
  candidates: number;
  queued: number;
  capReached: boolean;
}

export interface ResearchSubtaskDeps {
  loadResearch(): ResearchConfig;
  listCandidates: typeof listHighScoreResearchCandidates;
  request: typeof requestAutoResearch;
  deps(ctx: AiSubtaskContext): AutoResearchDeps;
}

const defaultDeps: ResearchSubtaskDeps = {
  loadResearch: () => reloadConfig("research"),
  listCandidates: listHighScoreResearchCandidates,
  request: requestAutoResearch,
  // the ai-worker's router knows what this process can start
  deps: (ctx) => ({ ...autoResearchDeps("ai-worker"), webOpen: async (task) => (await ctx.router.usable(task)).usable }),
};

/** More candidates than the limit: some will find everything cached, which does not use it up. */
const CANDIDATE_MARGIN = 20;

/**
 * The late `research` AI sub-task (`research.yaml` auto.high_score, off by default): new jobs with a high rank value get their
 * research queued in the batch lane, so it waits behind anything the user asked for. It only queues; the worker runs the requests.
 */
export async function runResearchSubtask(ctx: AiSubtaskContext, deps: ResearchSubtaskDeps = defaultDeps): Promise<ResearchSubtaskResult> {
  const result: ResearchSubtaskResult = { candidates: 0, queued: 0, capReached: false };
  let research: ResearchConfig;
  try {
    research = deps.loadResearch();
  } catch (error) {
    if (error instanceof ConfigError) return { ...result, skipped: "config_error" };
    throw error;
  }
  if (!research.enabled) return { ...result, skipped: "disabled" };
  const settings = research.auto.high_score;
  if (!settings.enabled) return { ...result, skipped: "off" };
  const db: Db | null = ctx.cycle.db;
  if (ctx.cycle.dryRun || db === null) return { ...result, skipped: ctx.cycle.dryRun ? "dry run" : "no database" };

  const now = new Date();
  const candidates = await deps.listCandidates(db, { minRank: settings.min_rank, maxAgeDays: settings.max_age_days, limit: settings.per_cycle_limit + CANDIDATE_MARGIN, now });
  result.candidates = candidates.length;
  const activity = ctx.activity ?? noopSpan;
  activity.progress(0, settings.per_cycle_limit);
  const requestDeps = deps.deps(ctx);
  for (const jobId of candidates) {
    if (ctx.cycle.signal.aborted || result.queued >= settings.per_cycle_limit) break;
    const { outcome } = await deps.request(db, { jobId, event: "high_score_new", now }, requestDeps);
    if (outcome === "queued") {
      result.queued += 1;
      activity.progress(result.queued, settings.per_cycle_limit);
      activity.item("item.ok", { jobId });
    }
    if (outcome === "cap_reached") {
      result.capReached = true;
      break;
    }
  }
  return result;
}

const researchSubtask: AiSubtask = {
  name: RESEARCH_SUBTASK_NAME,
  late: true,
  run: (ctx) => runResearchSubtask(ctx),
};

export function registerResearchSubtask(): void {
  registerAiSubtask(researchSubtask);
}
