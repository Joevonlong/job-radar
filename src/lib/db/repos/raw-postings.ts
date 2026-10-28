import { createHash } from "node:crypto";

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { rawPostings } from "../schema";

export type RawPosting = typeof rawPostings.$inferSelect;

export interface RawUpsertItem {
  externalId: string;
  url: string | null;
  /** JSON-serializable payload, stored verbatim (C1). */
  payload: unknown;
}

export interface RawUpsertResult {
  /** Rows created: postings this channel had not delivered before. */
  inserted: number;
  /** Rows whose payload changed; they are `pending` again. */
  changed: number;
  /** Rows delivered again with an identical payload; status untouched. */
  unchanged: number;
}

/** Keys sorted recursively so equal payloads hash equally whatever order the source used. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 (hex) over the canonical JSON form of a payload, after a JSON round trip (Dates → strings, undefined dropped). */
export function hashPayload(payload: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(payload));
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

const CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Upsert postings on (channel_id, external_id) (C1). New rows start `pending`. Existing rows get
 * their payload, url, `fetched_at` and `run_id` refreshed; they go back to `pending` only when the
 * payload hash changed, so an unchanged posting that is already parsed is not parsed again.
 * Duplicate external ids within one batch collapse to the last one.
 */
export async function upsertRawPostings(
  db: Db,
  input: { channelId: string; runId: number | null; items: readonly RawUpsertItem[]; fetchedAt?: Date },
): Promise<RawUpsertResult> {
  const byId = new Map<string, RawUpsertItem & { hash: string }>();
  for (const item of input.items) {
    byId.set(item.externalId, { ...item, payload: JSON.parse(JSON.stringify(item.payload)), hash: hashPayload(item.payload) });
  }
  const items = [...byId.values()];
  const result: RawUpsertResult = { inserted: 0, changed: 0, unchanged: 0 };
  if (items.length === 0) return result;
  const fetchedAt = input.fetchedAt ?? sql`now()`; // database clock, like the other defaults

  await db.transaction(async (tx) => {
    const existing = new Map<string, string | null>();
    for (const part of chunks(items, 1000)) {
      const rows = await tx
        .select({ externalId: rawPostings.externalId, hash: rawPostings.payloadHash })
        .from(rawPostings)
        .where(
          and(
            eq(rawPostings.channelId, input.channelId),
            inArray(
              rawPostings.externalId,
              part.map((i) => i.externalId),
            ),
          ),
        );
      for (const row of rows) existing.set(row.externalId, row.hash);
    }
    for (const item of items) {
      if (!existing.has(item.externalId)) result.inserted += 1;
      else if (existing.get(item.externalId) === item.hash) result.unchanged += 1;
      else result.changed += 1;
    }

    for (const part of chunks(items, CHUNK)) {
      await tx
        .insert(rawPostings)
        .values(
          part.map((i) => ({
            channelId: input.channelId,
            externalId: i.externalId,
            url: i.url,
            payloadJson: i.payload,
            payloadHash: i.hash,
            fetchedAt,
            runId: input.runId,
          })),
        )
        .onConflictDoUpdate({
          target: [rawPostings.channelId, rawPostings.externalId],
          set: {
            payloadJson: sql`excluded.payload_json`,
            url: sql`coalesce(excluded.url, ${rawPostings.url})`,
            fetchedAt: sql`excluded.fetched_at`,
            runId: sql`excluded.run_id`,
            parseStatus: sql`case when ${rawPostings.payloadHash} is distinct from excluded.payload_hash then 'pending'::parse_status else ${rawPostings.parseStatus} end`,
            parseError: sql`case when ${rawPostings.payloadHash} is distinct from excluded.payload_hash then null else ${rawPostings.parseError} end`,
            payloadHash: sql`excluded.payload_hash`,
          },
        });
    }
  });
  return result;
}

export async function listRawPostingsForChannel(db: Db, channelId: string): Promise<RawPosting[]> {
  return db.select().from(rawPostings).where(eq(rawPostings.channelId, channelId)).orderBy(rawPostings.id);
}

export async function setRawParseStatus(
  db: Db,
  id: number,
  status: RawPosting["parseStatus"],
): Promise<void> {
  await db.update(rawPostings).set({ parseStatus: status }).where(eq(rawPostings.id, id));
}

/** Longest parse error text stored in `raw_postings.parse_error`. */
const MAX_PARSE_ERROR_CHARS = 500;

/** The next `limit` pending postings with an id above `afterId`, oldest first (pipeline). */
export async function listPendingRawPostings(db: Executor, input: { afterId: number; limit: number }): Promise<RawPosting[]> {
  return db
    .select()
    .from(rawPostings)
    .where(and(eq(rawPostings.parseStatus, "pending"), gt(rawPostings.id, input.afterId)))
    .orderBy(asc(rawPostings.id))
    .limit(input.limit);
}

export async function markRawParsed(db: Executor, id: number): Promise<void> {
  await db.update(rawPostings).set({ parseStatus: "parsed", parseError: null }).where(eq(rawPostings.id, id));
}

/** C1: the payload stays; the reason is recorded. */
export async function markRawParseFailed(db: Executor, id: number, reason: string): Promise<void> {
  await db
    .update(rawPostings)
    .set({ parseStatus: "parse_failed", parseError: reason.slice(0, MAX_PARSE_ERROR_CHARS) })
    .where(eq(rawPostings.id, id));
}

/**
 * Put already processed raw postings (`parsed` or `parse_failed`) back to `pending`, so the next
 * `pipeline` run reads them again with the current rules (`pnpm reprocess`). Their payloads are not
 * touched (C1). Every channel when `channelIds` is empty. Returns how many were put back.
 */
export async function requeueRawPostings(db: Executor, channelIds: readonly string[] = []): Promise<number> {
  const rows = await db
    .update(rawPostings)
    .set({ parseStatus: "pending", parseError: null })
    .where(and(inArray(rawPostings.parseStatus, ["parsed", "parse_failed"]), channelIds.length > 0 ? inArray(rawPostings.channelId, [...channelIds]) : undefined))
    .returning({ id: rawPostings.id });
  return rows.length;
}

/** Put these raw postings back to `pending` (parsed or failed ones; a pending one stays). Returns the number changed. */
export async function requeueRawPostingsById(db: Executor, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(rawPostings)
    .set({ parseStatus: "pending", parseError: null })
    .where(and(inArray(rawPostings.parseStatus, ["parsed", "parse_failed"]), inArray(rawPostings.id, [...ids])))
    .returning({ id: rawPostings.id });
  return rows.length;
}

/**
 * The stored payloads of postings with these external ids among `channelIds` (earlier channel ids win when more than one holds the id).
 * Used by channels that re-deliver a posting they already hold instead of reading its page again: the same payload keeps the
 * hash, and delivering it refreshes `fetched_at`, which is what keeps the job "seen".
 */
export async function getRawPayloadsByExternalId(db: Db, input: { channelIds: readonly string[]; externalIds: readonly string[] }): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (input.channelIds.length === 0 || input.externalIds.length === 0) return result;
  const rows: Array<{ channelId: string; externalId: string; payload: unknown }> = [];
  for (const part of chunks(input.externalIds, 1000)) {
    rows.push(
      ...(await db
        .select({ channelId: rawPostings.channelId, externalId: rawPostings.externalId, payload: rawPostings.payloadJson })
        .from(rawPostings)
        .where(and(inArray(rawPostings.channelId, [...input.channelIds]), inArray(rawPostings.externalId, part)))),
    );
  }
  const rank = new Map(input.channelIds.map((id, index) => [id, index]));
  rows.sort((a, b) => (rank.get(a.channelId) ?? 0) - (rank.get(b.channelId) ?? 0));
  for (const row of rows) if (!result.has(row.externalId)) result.set(row.externalId, row.payload);
  return result;
}
