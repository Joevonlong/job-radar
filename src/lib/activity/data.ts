/** Parameter-based activity reads shared by the pages and operations capabilities. */
import { z } from "zod";
import { loadConfig } from "@/lib/config";
import { ConfigError } from "@/lib/config/errors";
import { activityTablesReady, getDb, getDbNow, getActivityRoot, listActivityEvents, listActivityRoots, listQueryRows, type Db } from "@/lib/db";
import { dayInZone } from "@/lib/insights/range";
import { displayChildStatus, displayStatus } from "./display-status";
import { resolveActivityRange, type ActivityUrlState } from "./search";

export interface ActivityLoadOptions { db?: Db; pageSize?: number }

async function context(url: ActivityUrlState, options: ActivityLoadOptions) {
  const config = loadConfig("activityLog");
  const timeZone = loadConfig("schedule").timezone;
  const db = options.db ?? getDb();
  const today = dayInZone(await getDbNow(db), timeZone);
  const liveness = { staleAfterSeconds: config.liveness.stale_after_seconds, startupGraceSeconds: config.liveness.startup_grace_seconds };
  return { url, config, timeZone, db, today, liveness };
}

/** Every config/DB failure is contained here. Pages only receive safe query projections and configured labels. */
export async function loadActivityListData(params: ActivityUrlState, options: ActivityLoadOptions = {}) {
  try {
    const ctx = await context(params, options);
    if (!(await activityTablesReady(ctx.db))) return { state: "not_ready" as const };
    const { url, config, timeZone, db, today, liveness } = ctx;
    const range = resolveActivityRange(url, today, config.ui.default_range_days, timeZone);
    const filter = { from: range.fromInstant, to: range.toInstant,
      ...(url.type !== "all" ? { scope: url.type } : {}), ...(url.status !== "all" ? { status: url.status } : {}), issuesOnly: url.issues === "1" };
    let result = await listActivityRoots(db, filter, { page: url.page, pageSize: (options.pageSize ?? config.ui.page_size) }, liveness);
    const page = Math.min(url.page, Math.max(1, Math.ceil(result.total / (options.pageSize ?? config.ui.page_size))));
    if (page !== url.page) result = await listActivityRoots(db, filter, { page, pageSize: (options.pageSize ?? config.ui.page_size) }, liveness);
    return { state: "ready" as const, url: { ...url, page }, config, timeZone, today, range, ...result,
      rows: result.rows.map((root) => ({ ...root, display: displayStatus(root) })) };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return { state: "error" as const };
  }
}

export async function loadActivityDetailData(rootId: string, params: ActivityUrlState, options: ActivityLoadOptions = {}) {
  if (!z.uuid().safeParse(rootId).success) return { state: "not_found" as const };
  try {
    const { url, config, timeZone, db, today, liveness } = await context(params, options);
    if (!(await activityTablesReady(db))) return { state: "not_ready" as const };
    const detail = await getActivityRoot(db, rootId, liveness);
    if (!detail) return { state: "not_found" as const };
    const [queries, initialEvents] = await Promise.all([
      listQueryRows(db, rootId),
      listActivityEvents(db, rootId, { page: url.page, pageSize: (options.pageSize ?? config.ui.events_page_size), ...(url.level !== "all" ? { level: url.level } : {}) }),
    ]);
    const page = Math.min(url.page, Math.max(1, Math.ceil(initialEvents.total / (options.pageSize ?? config.ui.events_page_size))));
    const events = page === url.page ? initialEvents : await listActivityEvents(db, rootId, { page, pageSize: (options.pageSize ?? config.ui.events_page_size), ...(url.level !== "all" ? { level: url.level } : {}) });
    return { state: "ready" as const, ...detail, url: { ...url, page }, config, timeZone, today, queries, events,
      display: displayStatus(detail.root), spans: detail.spans.map((span) => ({ ...span, display: displayChildStatus(span, detail.root) })),
    };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return { state: "error" as const };
  }
}
