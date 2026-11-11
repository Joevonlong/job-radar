/** Posting text anchors for fail-closed capability reads; never raw payloads or user files. */
import { asc, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { jobs } from "../schema";
import type { DayWindow } from "@/lib/insights/range";

const columns = { jobId: jobs.id, companyId: jobs.companyId, description: jobs.description };

export async function readJobTexts(db: Db, ids: readonly number[]) {
  return ids.length === 0 ? [] : db.select(columns).from(jobs).where(inArray(jobs.id, [...ids])).orderBy(asc(jobs.id));
}

export async function readCompanyTexts(db: Db, ids: readonly number[]) {
  return ids.length === 0 ? [] : db.select(columns).from(jobs).where(inArray(jobs.companyId, [...ids])).orderBy(asc(jobs.id));
}

export async function readWindowTexts(db: Db, window: DayWindow, timezone: string) {
  return db.select(columns).from(jobs).where(sql`(${jobs.firstSeenAt} at time zone ${timezone})::date between ${window.from}::date and ${window.to}::date`).orderBy(asc(jobs.id));
}
