import { ConfigError, firstConfigProblem, loadConfig } from "@/lib/config";
import type { DeliveryAuditConfig } from "@/lib/config/schemas/delivery-audit";
import { getDb, type Db } from "@/lib/db/client";
import { deliveryPayloadBytes, deliveryTablesReady } from "@/lib/db/repos/deliveries";

export type DeliveryProbe =
  | { state: "ok"; bytes: number | null; warnBytes: number }
  | { state: "config_error"; problem: string };

/** Read-only; a size warning never applies retention from doctor. */
export async function probeDeliveries(options: {
  db?: Db;
  loadConfig?: () => Pick<DeliveryAuditConfig, "retention">;
} = {}): Promise<DeliveryProbe> {
  let config;
  try {
    config = (options.loadConfig ?? (() => loadConfig("deliveryAudit")))();
  } catch (error) {
    return { state: "config_error", problem: error instanceof ConfigError ? firstConfigProblem(error) : "unreadable" };
  }
  const db = options.db ?? getDb();
  const bytes = await deliveryTablesReady(db) ? await deliveryPayloadBytes(db) : null;
  return { state: "ok", bytes, warnBytes: config.retention.warn_bytes };
}
