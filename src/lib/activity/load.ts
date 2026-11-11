import "server-only";

import { getTranslations } from "next-intl/server";
import { loadQueryPlaces } from "@/lib/channels/query-places";
import type { QueryPlaces } from "@/lib/channels/query";
import { loadConfig } from "@/lib/config";
import { watchedCompanyBoards } from "@/lib/companies/watched-boards";
import { logActionFailure } from "@/lib/logging/action-failure";
import { loadPipeline } from "@/lib/market";
import { currentWatchedCompanies } from "@/lib/filter";
import { ConfigError } from "@/lib/config/errors";
import { getCycle, getDb } from "@/lib/db";
import { dayInZone } from "@/lib/insights/range";
import { z } from "zod";
import { liveCompanyBoards, resolveQueryLabels, storedCompanyQueryKeys } from "./query-labels";
import { activitySearchSchema, type ActivitySearchParams } from "./search";

import { loadActivityListData, loadActivityDetailData } from "./data";

/** The location settings for query labels; a query whose labels cannot be worked out shows its id. */
function readQueryPlaces(): QueryPlaces | null {
  try {
    return loadQueryPlaces();
  } catch {
    return null;
  }
}

export async function loadActivityList(searchParams: Promise<ActivitySearchParams>) {
  try {
    return await loadActivityListData(activitySearchSchema.parse(await searchParams));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return { state: "error" as const };
  }
}

export async function loadActivityDetail(rootId: string, searchParams: Promise<ActivitySearchParams>) {
  if (!z.uuid().safeParse(rootId).success) return { state: "not_found" as const };
  try {
    const data = await loadActivityDetailData(rootId, activitySearchSchema.parse(await searchParams));
    if (data.state !== "ready") return data;
    const t = await getTranslations("activityLog");
    const cycle = data.root.cycleId === null ? null : await getCycle(getDb(), data.root.cycleId);
    const companies = liveCompanyBoards(() => watchedCompanyBoards(currentWatchedCompanies(), [], loadPipeline()), (error) => logActionFailure("activityQueryLabels", error));
    const queryLabels = resolveQueryLabels(loadConfig("search"), readQueryPlaces(), t, companies, storedCompanyQueryKeys(cycle?.summaryJson));
    const day = dayInZone(data.root.startedAt, data.timeZone);
    const aiParams = new URLSearchParams({ range: "custom", from: day, to: day });
    const task = ({ "request.translate_job": "translate", "request.breakdown_job": "breakdown", "request.score_jobs": "score", "request.rescore_stale": "score", "request.salary_lookup": "salary_lookup", "request.company_research": "company_research", "request.story_extract": "story_extract", "request.career_extract": "career_extract", "request.career_tailor": "career_tailor", "request.run_suggest": "suggest", "request.test_ai": "probe" } as Record<string, string>)[data.root.name];
    if (task) aiParams.set("task", task);
    return { ...data, queryLabels, aiUsageHref: `/sources/ai-usage?${aiParams}` };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return { state: "error" as const };
  }
}
export type ActivityListData = Extract<Awaited<ReturnType<typeof loadActivityList>>, { state: "ready" }>;
export type ActivityDetailData = Extract<Awaited<ReturnType<typeof loadActivityDetail>>, { state: "ready" }>;
