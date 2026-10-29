import "server-only";

import { getTranslations } from "next-intl/server";
import { loadConfig } from "@/lib/config";
import { ConfigError } from "@/lib/config/errors";
import { activityTablesReady, getDb, getDbNow, getActivityRoot, listActivityEvents, listActivityRoots, listQueryRows } from "@/lib/db";
import { dayInZone } from "@/lib/insights/range";
import { z } from "zod";
import { displayChildStatus, displayStatus } from "./display-status";
import { resolveQueryLabels } from "./query-labels";
import { activitySearchSchema, resolveActivityRange, type ActivitySearchParams } from "./search";

async function context(searchParams: Promise<ActivitySearchParams>) {
  const url = activitySearchSchema.parse(await searchParams);
  const config = loadConfig("activityLog");
  const timeZone = loadConfig("schedule").timezone;
  const db = getDb();
  const today = dayInZone(await getDbNow(db), timeZone);
  const liveness = { staleAfterSeconds: config.liveness.stale_after_seconds, startupGraceSeconds: config.liveness.startup_grace_seconds };
  return { url, config, timeZone, db, today, liveness };
}

/** Every config/DB failure is contained here. Pages only receive safe query projections and configured labels. */
export async function loadActivityList(searchParams: Promise<ActivitySearchParams>) {
  try {
    // Readiness must precede activity queries, including when migrations have not run yet.
    const ctx = await context(searchParams);
    if (!(await activityTablesReady(ctx.db))) return { state: "not_ready" as const };
    const { url, config, timeZone, db, today, liveness } = ctx;
    const range = resolveActivityRange(url, today, config.ui.default_range_days, timeZone);
    const filter = { from: range.fromInstant, to: range.toInstant,
      ...(url.type !== "all" ? { scope: url.type } : {}), ...(url.status !== "all" ? { status: url.status } : {}), issuesOnly: url.issues === "1" };
    let result = await listActivityRoots(db, filter, { page: url.page, pageSize: config.ui.page_size }, liveness);
    const page = Math.min(url.page, Math.max(1, Math.ceil(result.total / config.ui.page_size)));
    if (page !== url.page) result = await listActivityRoots(db, filter, { page, pageSize: config.ui.page_size }, liveness);
    return { state: "ready" as const, url: { ...url, page }, config, timeZone, today, range, ...result,
      rows: result.rows.map((root) => ({ ...root, display: displayStatus(root) })) };
  } catch (error) {
    // An invalid config file goes to the error page, which names the file; anything else is a read failure.
    if (error instanceof ConfigError) throw error;
    return { state: "error" as const };
  }
}

export async function loadActivityDetail(rootId: string, searchParams: Promise<ActivitySearchParams>) {
  if (!z.uuid().safeParse(rootId).success) return { state: "not_found" as const };
  try {
    const { url, config, timeZone, db, today, liveness } = await context(searchParams);
    if (!(await activityTablesReady(db))) return { state: "not_ready" as const };
    const detail = await getActivityRoot(db, rootId, liveness);
    if (!detail) return { state: "not_found" as const };
    const [queries, initialEvents, t] = await Promise.all([
      listQueryRows(db, rootId),
      listActivityEvents(db, rootId, { page: url.page, pageSize: config.ui.events_page_size, ...(url.level !== "all" ? { level: url.level } : {}) }),
      getTranslations("activityLog"),
    ]);
    const page = Math.min(url.page, Math.max(1, Math.ceil(initialEvents.total / config.ui.events_page_size)));
    const events = page === url.page ? initialEvents : await listActivityEvents(db, rootId, { page, pageSize: config.ui.events_page_size, ...(url.level !== "all" ? { level: url.level } : {}) });
    const queryLabels = resolveQueryLabels(loadConfig("search"), t);
    const day = dayInZone(detail.root.startedAt, timeZone);
    const aiParams = new URLSearchParams({ range: "custom", from: day, to: day });
    const task = ({ "request.translate_job": "translate", "request.breakdown_job": "breakdown", "request.score_jobs": "score", "request.rescore_stale": "score", "request.salary_lookup": "salary_lookup", "request.run_suggest": "suggest", "request.test_ai": "probe" } as Record<string, string>)[detail.root.name];
    if (task) aiParams.set("task", task);
    return { state: "ready" as const, ...detail, url: { ...url, page }, config, timeZone, today, queries, events, queryLabels,
      display: displayStatus(detail.root), spans: detail.spans.map((span) => ({ ...span, display: displayChildStatus(span, detail.root) })),
      aiUsageHref: `/sources/ai-usage?${aiParams}` };
  } catch (error) {
    // An invalid config file goes to the error page, which names the file; anything else is a read failure.
    if (error instanceof ConfigError) throw error;
    return { state: "error" as const };
  }
}
export type ActivityListData = Extract<Awaited<ReturnType<typeof loadActivityList>>, { state: "ready" }>;
export type ActivityDetailData = Extract<Awaited<ReturnType<typeof loadActivityDetail>>, { state: "ready" }>;
