import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { DELIVERY_DISPOSITIONS, DELIVERY_FLAGS, deliveryCountsSchema, type DeliveryCounts, type DeliveryDisposition, type DeliveryFlag } from "@/lib/channels/delivery";

import type { Db } from "../client";
import { deliveryItems, rawPostings, runDeliveries, runs } from "../schema";

export interface DeliveryItemView {
  ordinal: number;
  batch: number;
  disposition: DeliveryDisposition;
  flags: DeliveryFlag[];
  payloadBytes: number;
  payloadHash: string;
  externalId?: string | null;
  payload?: { state: "kept"; json: unknown; text: string | null } | { state: "not_kept" };
}

export interface DeliveryRunView {
  runId: number;
  distinctIds: number;
  summary: {
    ledger: "client" | "collect";
    delivered: number;
    billedUnits: number;
    distinctIds: number;
    windowCutoffAt: string | null;
    counts: DeliveryCounts;
  } | null;
  items: DeliveryItemView[];
}

type QueryItem = Omit<DeliveryItemView, "disposition" | "flags" | "payload"> & {
  disposition: string; flags: string[];
  payloadJson?: unknown; payloadText?: string | null; rawId?: number | null; rawPayload?: unknown;
};

/** The default query does not fetch payloads or external identifiers. */
export async function getDeliveryRun(db: Db, runId: number, options: { payload?: boolean } = {}): Promise<DeliveryRunView | null> {
  z.number().int().positive().safe().parse(runId);
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const [summary] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, runId));
  const [distinct] = await db.select({ count: sql<number>`count(distinct ${deliveryItems.externalId})::integer` }).from(deliveryItems).where(eq(deliveryItems.runId, runId));
  const columns = {
    ordinal: deliveryItems.ordinal, batch: deliveryItems.batch, disposition: deliveryItems.disposition,
    flags: deliveryItems.flags, payloadBytes: deliveryItems.payloadBytes, payloadHash: deliveryItems.payloadHash,
  };
  const rows: QueryItem[] = options.payload
    ? await db.select({ ...columns, externalId: deliveryItems.externalId, payloadJson: deliveryItems.payloadJson, payloadText: deliveryItems.payloadText, rawId: rawPostings.id, rawPayload: rawPostings.payloadJson })
      .from(deliveryItems).leftJoin(rawPostings, and(eq(rawPostings.id, deliveryItems.rawPostingId), eq(rawPostings.payloadHash, deliveryItems.payloadHash)))
      .where(eq(deliveryItems.runId, runId)).orderBy(asc(deliveryItems.ordinal))
    : await db.select(columns).from(deliveryItems).where(eq(deliveryItems.runId, runId)).orderBy(asc(deliveryItems.ordinal));
  const items = rows.map((row): DeliveryItemView => {
    const item: DeliveryItemView = {
      ordinal: row.ordinal, batch: row.batch, disposition: z.enum(DELIVERY_DISPOSITIONS).parse(row.disposition),
      flags: z.array(z.enum(DELIVERY_FLAGS)).parse(row.flags), payloadBytes: row.payloadBytes, payloadHash: row.payloadHash,
    };
    if (options.payload) {
      item.externalId = row.externalId ?? null;
      item.payload = item.disposition === "stored"
        ? row.rawId == null ? { state: "not_kept" } : { state: "kept", json: row.rawPayload, text: null }
        : { state: "kept", json: row.payloadJson, text: row.payloadText ?? null };
    }
    return item;
  });
  return {
    runId, distinctIds: distinct?.count ?? 0, items,
    summary: summary ? {
      ledger: z.enum(["client", "collect"]).parse(summary.ledger), delivered: summary.delivered,
      billedUnits: summary.billedUnits, distinctIds: summary.distinctIds,
      windowCutoffAt: summary.windowCutoffAt?.toISOString() ?? null, counts: deliveryCountsSchema.parse(summary.countsJson),
    } : null,
  };
}
