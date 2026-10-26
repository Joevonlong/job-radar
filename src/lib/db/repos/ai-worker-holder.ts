/** Read-only upgrade gate: the worker's instance-lock holder, independent of its service definition or heartbeats. */
import { z } from "zod";

import { findInstanceLockHolder, instanceApplicationName } from "../instance-lock";
import type { EvidenceConnection } from "./ai-worker-evidence";

export const workerHolderSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({ status: z.literal("expected") }),
  z.strictObject({ status: z.literal("other") }),
  z.strictObject({ status: z.literal("unknown"), reason: z.literal("holder-not-visible") }),
]);

export async function workerHolder(conn: EvidenceConnection, expected: { pid: number; host: string }): Promise<z.infer<typeof workerHolderSchema>> {
  const holder = await findInstanceLockHolder(conn.sql);
  if (holder === null) return { status: "none" };
  if (holder.application === null || holder.sinceExact === null) return { status: "unknown", reason: "holder-not-visible" };
  // Compare the same truncated identity the worker publishes; never reverse-parse a potentially truncated host name.
  return { status: holder.application === instanceApplicationName("ai-worker", expected.pid, expected.host) ? "expected" : "other" };
}
