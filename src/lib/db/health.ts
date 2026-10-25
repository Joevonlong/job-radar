import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { getChannelRows } from "./repos/channels";
import { getLatestHeartbeat } from "./repos/heartbeats";
import { getRawPayloadsByExternalId } from "./repos/raw-postings";

/** True when the database answers a trivial query. Never throws and never exposes the error. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export type CycleStateProbe = "ok" | "not_migrated" | "unreadable" | "unreachable";

const SCHEMA_MISSING = new Set(["42P01", "42703"]); // undefined_table, undefined_column

/** `not_migrated` when a probe read failed because a table or column is missing, otherwise `unreadable`. Exported for tests. */
export function classifyProbeFailure(error: unknown): "not_migrated" | "unreadable" {
  // postgres.js puts the SQLSTATE on `code`; drizzle may wrap the driver error in `cause`
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 3; e = (e as { cause?: unknown }).cause, depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return SCHEMA_MISSING.has(code) ? "not_migrated" : "unreadable";
  }
  return "unreadable";
}

/** Can a dry run read the persisted cycle state (channels, raw_postings) here? Never throws and never exposes the error. */
export async function probeCycleState(db: Db): Promise<CycleStateProbe> {
  if (!(await pingDb(db))) return "unreachable";
  try {
    await getChannelRows(db, ["__probe__"]); // selects every channels column: a schema behind the code fails here too
    await getRawPayloadsByExternalId(db, { channelIds: ["__probe__"], externalIds: ["__probe__"] });
    return "ok";
  } catch (error) {
    return classifyProbeFailure(error);
  }
}

/** Latest runner heartbeat time, or null when none exists (or the table is not migrated yet). */
export async function readLatestHeartbeatAt(db: Db): Promise<Date | null> {
  try {
    return (await getLatestHeartbeat(db))?.at ?? null;
  } catch {
    return null;
  }
}
