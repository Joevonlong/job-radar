/**
 * Automatic research: when a saved job, a status change or a new high-score job may start the company lookup, the JD breakdown
 * and the salary lookup by itself, and what that run may do. Never throws: the user's click or the cycle must not depend on it.
 */
import { newId } from "@/lib/activity/ids";
import { giveBackAgentBudget, takeIndirectBudget } from "@/lib/agent-access/budget";
import type { AgentCaller } from "@/lib/agent-access/caller";
import type { ActivityProcess } from "@/lib/activity/types";
import { createDbHealthStore } from "@/lib/ai/health";
import { COMPANY_RESEARCH_PROMPT_VERSION } from "@/lib/ai/prompts/company-research";
import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import { createDbQuotaStore } from "@/lib/ai/quota-guard";
import { anyProviderOpen } from "@/lib/ai/state-gate";
import { createDbUsageStore } from "@/lib/ai/usage";
import { readBreakdownSettings, type BreakdownSettingsState } from "@/lib/breakdown/settings";
import { ConfigError, loadConfig, reloadConfig, type AiConfig, type ResearchConfig } from "@/lib/config";
import type { ResearchItem } from "@/lib/config/schemas/research";
import { requestBreakdownJob } from "@/lib/control/breakdown-request";
import { companyResearchProviders, requestCompanyResearch } from "@/lib/control/company-research-request";
import { requestSalaryLookup, salaryLookupProviders } from "@/lib/control/salary-request";
import type { Db } from "@/lib/db/client";
import type { ApplicationStatus } from "@/lib/db";
import { activityTablesReady, writeActivityBatch } from "@/lib/db/repos/activity";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { companyResearchCurrent, confirmedWebsiteDomain, findLatestCompanyResearch, getJobForCompanyResearch } from "@/lib/db/repos/company-research";
import { hasRecentAutoRun, reserveAutoResearchRun, updateAutoRunItems, type ResearchAutoItems, type ResearchAutoTrigger } from "@/lib/db/repos/research-auto-runs";
import { findLatestSalaryLookup, getJobForSalaryLookup } from "@/lib/db/repos/salary-lookups";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupKey } from "@/lib/salary/lookup-key";
import { readSalarySettings, type SalarySettingsState } from "@/lib/salary/settings";
import { descriptionHash } from "@/lib/translation/hash";

const log = createProcessLogger({ fields: { component: "research" } });

export type AutoResearchOutcome = "off" | "recent" | "all_cached" | "nothing_to_run" | "deferred_quota" | "cap_reached" | "budget_skipped" | "queued" | "failed";
export type AutoResearchResult = { outcome: AutoResearchOutcome; items: ResearchAutoItems };
/** What happened to one part: asked for (`queued`), nothing to do, or why it did not run. */
export type AutoResearchItemState = "queued" | "cached" | "disabled" | "no_web_provider" | "no_description" | "deferred_quota" | "failed";

/** Whether this event starts research under these settings. */
export function shouldAutoResearch(event: ResearchAutoTrigger, research: ResearchConfig): boolean {
  if (!research.enabled) return false;
  if (event === "high_score_new") return research.auto.high_score.enabled;
  if (event === "favorite") return research.auto.trigger === "favorite" || research.auto.trigger === "favorite_or_applying";
  return research.auto.trigger === "favorite_or_applying";
}

const RESEARCH_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>(["interested", "preparing", "applied"]);

export const statusStartsResearch = (status: ApplicationStatus): boolean => RESEARCH_STATUSES.has(status);

export interface AutoResearchDeps {
  research(): ResearchConfig;
  ai(): AiConfig;
  salary(): SalarySettingsState;
  breakdown(): BreakdownSettingsState;
  timeZone(): string;
  /** Whether a web task could run now. Default: what shared state says of its providers (the web and the runner cannot start a CLI). */
  webOpen?(task: "company_research" | "salary_lookup", providers: readonly string[]): Promise<boolean>;
  /** Outcomes already recorded by this batch: a cycle's high-score run writes one activity row per reason, not one per job. */
  reportedOnce?: Set<AutoResearchOutcome>;
  process: ActivityProcess;
}

const defaultDeps = (process: ActivityProcess): AutoResearchDeps => ({
  research: () => reloadConfig("research"),
  ai: () => reloadConfig("ai"),
  salary: readSalarySettings,
  breakdown: readBreakdownSettings,
  timeZone: () => loadConfig("schedule").timezone,
  process,
});

async function writeRunActivity(db: Db, input: { jobId: number; process: ActivityProcess; trigger: ResearchAutoTrigger; outcome: AutoResearchOutcome; queued: number; now: Date }): Promise<void> {
  try {
    if (!(await activityTablesReady(db))) return;
    const id = newId();
    const reasonCode = input.outcome === "cap_reached" ? "research_cap_reached" : input.outcome === "recent" ? "research_recent" : input.outcome === "deferred_quota" ? "quota_guard" : null;
    await writeActivityBatch(db, {
      roots: [
        {
          id, rootId: id, parentId: null,
          scope: "system", name: "system.research_auto", process: input.process, status: input.outcome === "queued" ? "ok" : "skipped",
          reasonCode,
          startedAt: input.now, finishedAt: input.now, lastActivityAt: input.now,
          progressDone: null, progressTotal: null, eventsDropped: 0,
          cycleId: null, controlRequestId: null, runId: null, jobId: input.jobId,
          channelId: null, queryId: null,
        },
      ],
      spans: [],
      events: [
        {
          id: newId(), rootId: id, spanId: id, at: input.now,
          level: "info", code: "research_auto",
          jobId: input.jobId, rawPostingId: null,
          params: { outcome: input.outcome, trigger: input.trigger, queued: input.queued },
        },
      ],
      batchSize: 1,
    });
  } catch (error) {
    log.warn("could not record automatic research", { jobId: input.jobId, error: error instanceof Error ? error.name : "unknown" });
  }
}

/** Is there anything for this part to do? Cached parts need no run; a part that is off is said so. */
async function itemNeed(db: Db, item: ResearchItem, input: { jobId: number; now: Date; nonCompanyHosts: readonly string[]; breakdown: BreakdownSettingsState; salary: SalarySettingsState }): Promise<AutoResearchItemState | "run"> {
  if (item === "company") {
    const job = await getJobForCompanyResearch(db, input.jobId);
    if (!job) return "failed";
    const latest = await findLatestCompanyResearch(db, { companyId: job.companyId, promptVersion: COMPANY_RESEARCH_PROMPT_VERSION, now: input.now });
    return companyResearchCurrent(latest, confirmedWebsiteDomain(job, input.nonCompanyHosts)) ? "cached" : "run";
  }
  if (item === "breakdown") {
    if (input.breakdown.state === "error" || !input.breakdown.config.enabled) return "disabled";
    const job = await getJobForBreakdown(db, input.jobId);
    if (!job) return "failed";
    if (job.description === null || job.description.trim() === "") return "no_description";
    const existing = await getJobBreakdown(db, input.jobId);
    return existing && existing.sourceHash === descriptionHash(job.description) && existing.promptVersion === BREAKDOWN_PROMPT_VERSION ? "cached" : "run";
  }
  if (input.salary.state === "error" || !input.salary.config.lookup.enabled) return "disabled";
  const job = await getJobForSalaryLookup(db, input.jobId);
  if (!job) return "failed";
  const lookupKey = salaryLookupKey(job, compileFamilies(input.salary.config.role_families).familyOf(job.title));
  const cached = await findLatestSalaryLookup(db, { lookupKey, promptVersion: SALARY_PROMPT_VERSION });
  return cached && cached.expiresAt > input.now ? "cached" : "run";
}

async function run(db: Db, input: { jobId: number; event: ResearchAutoTrigger; now: Date; caller?: AgentCaller }, deps: AutoResearchDeps): Promise<AutoResearchResult> {
  const research = deps.research();
  if (!shouldAutoResearch(input.event, research)) return { outcome: "off", items: {} };
  const record = async (outcome: AutoResearchOutcome, queued: number): Promise<void> => {
    if (outcome !== "queued" && deps.reportedOnce) {
      if (deps.reportedOnce.has(outcome)) return;
      deps.reportedOnce.add(outcome);
    }
    await writeRunActivity(db, { jobId: input.jobId, process: deps.process, trigger: input.event, outcome, queued, now: input.now });
  };
  const report = async (outcome: AutoResearchOutcome, items: ResearchAutoItems, queued = 0) => {
    await record(outcome, queued);
    return { outcome, items };
  };
  if (await hasRecentAutoRun(db, input.jobId, input.now)) return report("recent", {});

  const ai = deps.ai();
  const salary = deps.salary();
  const breakdown = deps.breakdown();
  const timeZone = deps.timeZone();
  const stores = { health: createDbHealthStore(db), quota: createDbQuotaStore(db), usage: createDbUsageStore(db) };
  const webOpen = (task: "company_research" | "salary_lookup", providers: ReturnType<typeof companyResearchProviders>): Promise<boolean> =>
    deps.webOpen ? deps.webOpen(task, providers) : anyProviderOpen(ai, providers, stores, input.now, timeZone);

  const items: ResearchAutoItems = {};
  const toQueue: ResearchItem[] = [];
  for (const item of research.auto.items) {
    let state = await itemNeed(db, item, { jobId: input.jobId, now: input.now, nonCompanyHosts: research.company.non_company_hosts, breakdown, salary });
    if (state === "run" && item !== "breakdown") {
      const task = item === "company" ? "company_research" : "salary_lookup";
      const providers = item === "company" ? companyResearchProviders(ai) : salaryLookupProviders(ai);
      if (providers.length === 0) state = "no_web_provider";
      else if (!(await webOpen(task, providers))) state = "deferred_quota";
    }
    if (state === "run") toQueue.push(item);
    else items[item] = state;
  }
  if (toQueue.length === 0) {
    const states = Object.values(items);
    if (states.includes("deferred_quota")) return report("deferred_quota", items);
    return { outcome: states.includes("cached") ? "all_cached" : "nothing_to_run", items };
  }

  const budget = input.caller === undefined ? null : await takeIndirectBudget(db, { caller: input.caller, action: "research_company" });
  if (budget?.decision === "skip") return report("budget_skipped", items);
  let added = 0;
  try {
    const cap = input.event === "high_score_new" ? research.auto.high_score.max_per_day : research.auto.max_per_day;
    const reserved = await reserveAutoResearchRun(db, { jobId: input.jobId, trigger: input.event, items, maxPerDay: cap, now: input.now });
    if (reserved.state === "recent") return report("recent", items);
    if (reserved.state === "cap_reached") return report("cap_reached", items);

    let queued = 0;
    for (const item of toQueue) {
      const common = { jobId: input.jobId, force: false, origin: "auto" as const };
      const result =
        item === "company"
          ? await requestCompanyResearch(db, { ...common, research, ai, now: input.now })
          : item === "breakdown"
            ? await requestBreakdownJob(db, { ...common, settings: breakdown })
            : await requestSalaryLookup(db, { ...common, salary: salary.state === "ok" ? salary.config : null, ai, now: input.now });
      if (result.state === "queued") {
        items[item] = "queued";
        queued += 1;
        if (!result.existing) added += 1;
      } else items[item] = result.state === "cached" ? "cached" : "failed";
    }
    await updateAutoRunItems(db, reserved.runId, items);
    if (Object.values(items).includes("deferred_quota")) await record("deferred_quota", 0);
    return report("queued", items, queued);
  } finally {
    if (budget?.decision === "go" && added === 0) await giveBackAgentBudget(db, budget.ticket);
  }
}

/** One event's research. Everything that goes wrong ends in `failed` and a log line. */
export async function requestAutoResearch(db: Db, input: { jobId: number; event: ResearchAutoTrigger; now?: Date; caller?: AgentCaller }, deps: AutoResearchDeps = defaultDeps("web")): Promise<AutoResearchResult> {
  try {
    const request = { ...input, now: input.now ?? new Date() };
    return input.caller === undefined ? await run(db, request, deps) : await db.transaction((tx) => run(tx, request, deps));
  } catch (error) {
    if (!(error instanceof ConfigError)) log.warn("automatic research failed", { jobId: input.jobId, error: error instanceof Error ? error.name : "unknown" });
    return { outcome: "failed", items: {} };
  }
}

/** For a process other than the web. */
export const autoResearchDeps = defaultDeps;

/** Fire and forget from a Server Action: the user's click does not wait for the checks, and nothing can reject. */
export function triggerAutoResearch(db: Db, input: { jobId: number; event: ResearchAutoTrigger; caller?: AgentCaller }): Promise<AutoResearchResult> {
  return requestAutoResearch(db, input);
}
