import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "./executor";

/** Only call inside a transaction: limits disappear on commit or rollback, including pooled sessions. */
export async function setLocalWriteTimeout(tx: Executor, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined) return;
  const timeout = `${z.number().int().positive().parse(timeoutMs)}ms`;
  await tx.execute(sql`select set_config('statement_timeout', ${timeout}, true), set_config('lock_timeout', ${timeout}, true)`);
}
