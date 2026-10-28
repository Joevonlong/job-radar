"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSchedule } from "@/lib/dashboard/context";
import { getDb, listUnseenJobIds, markSeen, markSeenIds, markUnseen, recordVisit, SEEN_VIAS, undoBulkSeen } from "@/lib/db";
import { jobsListFilters } from "@/lib/jobs/list-filters";
import { loadJobsSearchParams, withLegacyKeys } from "@/lib/jobs/search-params";

/**
 * Server Actions for "new since my last visit" and the seen / unseen state of single jobs. Single-user app
 * bound to loopback (C5): no session to check; the input is still validated (C6).
 */

/** The lists that show seen state: refreshed (and their client cache dropped) after a change, so "back" shows the new state. */
function refreshLists(): void {
  for (const path of ["/", "/jobs", "/favorites"]) revalidatePath(path, "page");
}

/** The user opened Today or /jobs. Does not refresh the page: the divider stays for the whole visit. */
export async function recordVisitAction(): Promise<void> {
  try {
    await recordVisit(getDb(), new Date());
  } catch (error) {
    logActionFailure("recordVisitAction", error);
    // a missing marker only means the divider is off; never break the page over it
  }
}

const jobId = z.number().int().positive();
const markSeenInput = z.object({ jobId, via: z.enum(SEEN_VIAS) });

export type SeenActionResult = { ok: true; changed: boolean } | { ok: false };

/**
 * The job was seen: its detail page is on screen (`detail`, called from the browser, never while the server renders, so a
 * prefetch of a list link marks nothing), its posting was opened (`source`), or the user acted on its row (`action`). The first
 * sighting is kept.
 */
export async function markSeenAction(input: { jobId: number; via: string }): Promise<SeenActionResult> {
  const parsed = markSeenInput.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const changed = await markSeen(getDb(), parsed.data.jobId, parsed.data.via);
    if (changed) refreshLists();
    return { ok: true, changed };
  } catch (error) {
    logActionFailure("markSeenAction", error);
    // a foreign key miss (no such job) or the table not migrated yet: the bold stays, nothing else breaks
    return { ok: false };
  }
}

/** "Mark as unseen" (the detail page's menu, `u` on a row): the job is bold with a dot again. */
export async function markUnseenAction(input: { jobId: number }): Promise<SeenActionResult> {
  const parsed = z.object({ jobId }).safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const changed = await markUnseen(getDb(), parsed.data.jobId);
    if (changed) refreshLists();
    return { ok: true, changed };
  } catch (error) {
    logActionFailure("markUnseenAction", error);
    return { ok: false };
  }
}

/** Longest /jobs query string the action accepts (a URL is far shorter; anything longer is not one). */
const MAX_QUERY_CHARS = 8_000;
/** Most job ids one Today "mark all seen" takes (the Today list is one screen of a day's jobs). */
const MAX_LISTED_IDS = 5_000;

const markAllInput = z.discriminatedUnion("scope", [
  /** /jobs: every unseen job of the list the query string selects, across all its pages (parsed by the page's own parsers). */
  z.object({ scope: z.literal("jobs"), query: z.string().max(MAX_QUERY_CHARS), renderedAt: z.iso.datetime({ offset: true }) }),
  /** Today: the jobs of the view on screen. */
  z.object({ scope: z.literal("list"), jobIds: z.array(jobId).max(MAX_LISTED_IDS) }),
]);

export type MarkAllSeenResult = { ok: true; count: number; at: string } | { ok: false };

/**
 * "Mark all seen": the unseen jobs of the list become seen as one batch (one `seen_at`); the answer carries the batch's time
 * for the undo. On /jobs the list is rebuilt from the query string with the page's parsers, so "all" means every page of what is on
 * screen, limited to jobs first seen by the time the page was drawn (`renderedAt`). The visit marker is not moved (it only draws the "new since your last visit" divider).
 */
export async function markAllSeenAction(input: { scope: "jobs"; query: string; renderedAt: string } | { scope: "list"; jobIds: number[] }): Promise<MarkAllSeenResult> {
  const parsed = markAllInput.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const db = getDb();
    const at = new Date();
    let ids: number[];
    if (parsed.data.scope === "list") {
      ids = parsed.data.jobIds;
    } else {
      const params = withLegacyKeys(loadJobsSearchParams(new URLSearchParams(parsed.data.query)));
      const filters = await jobsListFilters(db, params);
      // jobs that arrived after the page was drawn were never on screen: they stay unseen
      const renderedAt = new Date(Math.min(Date.parse(parsed.data.renderedAt), at.getTime()));
      ids = await listUnseenJobIds(db, { filters, timezone: getSchedule().timezone, firstSeenUpTo: renderedAt });
    }
    const count = await markSeenIds(db, ids, at);
    if (count > 0) refreshLists();
    return { ok: true, count, at: at.toISOString() };
  } catch (error) {
    logActionFailure("markAllSeenAction", error);
    return { ok: false };
  }
}

/** Undo one "mark all seen": only that batch's rows are removed (jobs seen before it stay seen). */
export async function undoMarkAllSeenAction(input: { at: string }): Promise<{ ok: boolean }> {
  const parsed = z.object({ at: z.iso.datetime({ offset: true }) }).safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    await undoBulkSeen(getDb(), new Date(parsed.data.at));
    refreshLists();
    return { ok: true };
  } catch (error) {
    logActionFailure("undoMarkAllSeenAction", error);
    return { ok: false };
  }
}
