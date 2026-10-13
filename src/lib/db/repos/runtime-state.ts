import { eq, like, sql } from "drizzle-orm";

import { SHIPPED_CONFIG_PROCESSES, shippedConfigReportSchema, type ShippedConfigProcess, type ShippedConfigReport } from "@/lib/config/shipped-id";

import type { Db } from "../client";
import { runtimeState } from "../schema";

export interface RuntimeStateRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

export async function setRuntimeState(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(runtimeState)
    .values({ key, value })
    .onConflictDoUpdate({ target: runtimeState.key, set: { value, updatedAt: sql`now()` } });
}

export async function getRuntimeState(db: Db, key: string): Promise<RuntimeStateRow | null> {
  const [row] = await db
    .select({ key: runtimeState.key, value: runtimeState.value, updatedAt: runtimeState.updatedAt })
    .from(runtimeState)
    .where(eq(runtimeState.key, key))
    .limit(1);
  return row ?? null;
}

/** Every row whose key starts with `prefix` (use a prefix that ends with the separator, e.g. `config_loaded:`). */
export async function listRuntimeState(db: Db, prefix: string): Promise<RuntimeStateRow[]> {
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db
    .select({ key: runtimeState.key, value: runtimeState.value, updatedAt: runtimeState.updatedAt })
    .from(runtimeState)
    .where(like(runtimeState.key, `${escaped}%`));
}

/**
 * Writes part of a JSON object without a read: a new row gets `insert`, an existing one keeps its other keys and gets the
 * keys of `patch` (a jsonb `||` merge in one statement, so two writers of different keys never undo each other).
 */
export async function mergeRuntimeState(db: Db, key: string, values: { insert: Record<string, unknown>; patch: Record<string, unknown> }): Promise<void> {
  await db
    .insert(runtimeState)
    .values({ key, value: values.insert })
    .onConflictDoUpdate({
      target: runtimeState.key,
      set: { value: sql`(case when jsonb_typeof(${runtimeState.value}) = 'object' then ${runtimeState.value} else '{}'::jsonb end) || ${JSON.stringify(values.patch)}::jsonb`, updatedAt: sql`now()` },
    });
}

// ---------------------------------------------------------------- shipped config reports

const SHIPPED_CONFIG_PREFIX = "shipped_config:";

/** One process's report and when it was written (database clock). */
export interface ShippedConfigReportRow {
  report: ShippedConfigReport;
  updatedAt: Date;
}

/** Write (or refresh) the shipped config report of `process`; `updated_at` is the database's `now()`. */
export async function reportShippedConfig(db: Db, process: ShippedConfigProcess, report: ShippedConfigReport): Promise<void> {
  await setRuntimeState(db, `${SHIPPED_CONFIG_PREFIX}${process}`, shippedConfigReportSchema.parse(report));
}

/** The newest report of each process; null when there is none or it does not pass the schema (treated as no report). */
export async function readShippedConfigReports(db: Db): Promise<Record<ShippedConfigProcess, ShippedConfigReportRow | null>> {
  const reports = Object.fromEntries(SHIPPED_CONFIG_PROCESSES.map((name) => [name, null])) as Record<ShippedConfigProcess, ShippedConfigReportRow | null>;
  for (const row of await listRuntimeState(db, SHIPPED_CONFIG_PREFIX)) {
    const process = SHIPPED_CONFIG_PROCESSES.find((name) => `${SHIPPED_CONFIG_PREFIX}${name}` === row.key);
    const parsed = shippedConfigReportSchema.safeParse(row.value);
    if (process !== undefined && parsed.success) reports[process] = { report: parsed.data, updatedAt: row.updatedAt };
  }
  return reports;
}
