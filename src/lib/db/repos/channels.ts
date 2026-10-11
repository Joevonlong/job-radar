import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../client";
import { channels } from "../schema";

export type ChannelRow = typeof channels.$inferSelect;
export type CircuitState = ChannelRow["circuitState"];
export type ChannelHealth = ChannelRow["health"];

export interface ChannelRowInput {
  id: string;
  family: string;
  kind: string;
  enabled: boolean;
}

/** Make sure a `channels` row exists for every registered channel (FK target of runs / raw_postings). */
export async function upsertChannelRows(db: Db, rows: readonly ChannelRowInput[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(channels)
    .values(rows.map((r) => ({ id: r.id, family: r.family, kind: r.kind, enabled: r.enabled })))
    .onConflictDoUpdate({
      target: channels.id,
      set: { family: sql`excluded.family`, kind: sql`excluded.kind`, enabled: sql`excluded.enabled` },
    });
}

export async function getChannelRows(db: Db, ids?: readonly string[]): Promise<ChannelRow[]> {
  if (ids !== undefined && ids.length === 0) return [];
  return ids === undefined ? db.select().from(channels) : db.select().from(channels).where(inArray(channels.id, [...ids]));
}

export interface CircuitStateInput {
  circuitState: CircuitState;
  consecutiveFailures: number;
  circuitOpenUntil: Date | null;
  lastErrorCode: string | null;
  lastSuccessAt: Date | null;
  health: ChannelHealth;
}

export async function saveCircuitState(db: Db, id: string, state: CircuitStateInput): Promise<void> {
  await db.update(channels).set(state).where(eq(channels.id, id));
}

// ---------------------------------------------------------------- monthly usage

/** `channels.month_usage` shape: `{ "2026-10": { records, usd } }`. */
const monthUsageSchema = z.record(
  z.string(),
  z.object({ records: z.number().default(0), usd: z.number().default(0) }),
);

export interface MonthUsage {
  records: number;
  usd: number;
}

/** Usage of `month` (`YYYY-MM`) per channel id; channels without usage are absent. */
export async function getMonthUsage(db: Db, month: string): Promise<Map<string, MonthUsage>> {
  const rows = await db.select({ id: channels.id, usage: channels.monthUsage }).from(channels);
  const result = new Map<string, MonthUsage>();
  for (const row of rows) {
    const parsed = monthUsageSchema.safeParse(row.usage);
    const entry = parsed.success ? parsed.data[month] : undefined;
    if (entry) result.set(row.id, { records: entry.records, usd: entry.usd });
  }
  return result;
}

/** Atomically add to a channel's usage for `month`. */
export async function addMonthUsage(db: Db, id: string, month: string, delta: MonthUsage): Promise<void> {
  await db.execute(sql`
    update channels
    set month_usage = jsonb_set(
      coalesce(month_usage, '{}'::jsonb),
      array[${month}::text],
      jsonb_build_object(
        'records', coalesce((month_usage -> ${month}::text ->> 'records')::bigint, 0) + ${delta.records}::bigint,
        'usd', coalesce((month_usage -> ${month}::text ->> 'usd')::numeric, 0) + ${delta.usd}::numeric
      ),
      true
    )
    where id = ${id}
  `);
}
