import { parseArgs } from "node:util";

import { z } from "zod";

import { LOCALES, type Locale } from "@/i18n/locale";
import { DELIVERY_DISPOSITIONS, type DeliveryCounts, type DeliveryDisposition } from "@/lib/channels/delivery";
import type { DeliveryRunView } from "@/lib/db/queries/deliveries";
import { translatorFor } from "@/lib/i18n/node";

export const deliveryText = (locale: Locale) => translatorFor(locale, "deliveries");
type DeliveryText = ReturnType<typeof deliveryText>;

const argsSchema = z.strictObject({
  run: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().safe()),
  disposition: z.array(z.enum(DELIVERY_DISPOSITIONS)).optional(),
  payload: z.boolean().optional(), json: z.boolean().optional(), lang: z.enum(LOCALES).optional(),
});

export function parseDeliveryArgs(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    run: { type: "string" }, disposition: { type: "string", multiple: true }, payload: { type: "boolean" },
    json: { type: "boolean" }, lang: { type: "string" },
  } });
  const parsed = argsSchema.parse(values);
  return { runId: parsed.run, dispositions: parsed.disposition ?? [], payload: parsed.payload ?? false, json: parsed.json ?? false, lang: parsed.lang };
}

interface FormatOptions {
  payload: boolean;
  json: boolean;
  dispositions: readonly DeliveryDisposition[];
}
export interface DeliveryOutput { output: string; exitCode: 0 | 1 }

function incompleteCounts(view: DeliveryRunView): DeliveryCounts {
  const counts: DeliveryCounts = { dispositions: {}, flags: {} };
  for (const item of view.items) {
    counts.dispositions[item.disposition] = (counts.dispositions[item.disposition] ?? 0) + 1;
    for (const flag of new Set(item.flags)) counts.flags[flag] = (counts.flags[flag] ?? 0) + 1;
  }
  return counts;
}

/** Only this explicit projection is printable; even an over-fetched view cannot leak payloads by default. */
export function formatDeliveries(view: DeliveryRunView | null, options: FormatOptions, t: DeliveryText): DeliveryOutput {
  if (view === null) {
    const message = t("notFound");
    return { exitCode: 1, output: options.json ? JSON.stringify({ state: "not_found", message }) : message };
  }
  const summary = view.summary ?? {
    ledger: null, delivered: view.items.length, billedUnits: null, distinctIds: view.distinctIds,
    windowCutoffAt: null, counts: incompleteCounts(view),
  };
  const state = view.summary === null ? "incomplete" : "completed";
  const message = view.summary === null ? t("incomplete") : t("completed");
  const items = view.items.filter((item) => options.dispositions.length === 0 || options.dispositions.includes(item.disposition)).map((item) => ({
    ordinal: item.ordinal, batch: item.batch, disposition: item.disposition, flags: item.flags,
    bytes: item.payloadBytes, hashPrefix: item.payloadHash.slice(0, 12),
    ...(options.payload ? {
      externalId: item.externalId ?? null,
      payload: item.payload?.state === "kept" ? item.payload : { state: "not_kept" as const, message: t("notKept") },
    } : {}),
  }));
  if (options.json) return { exitCode: 0, output: JSON.stringify({ state, message, runId: view.runId, summary, items }, null, 2) };
  const counts = (entries: Record<string, number>) => Object.entries(entries).map(([code, count]) => `${code}=${count}`).join(", ") || t("none");
  const lines = [
    t("run", { id: view.runId, state: message }),
    t("summary", { ledger: summary.ledger ?? t("unknown"), delivered: summary.delivered, billed: summary.billedUnits ?? t("unknown"), distinct: summary.distinctIds, cutoff: summary.windowCutoffAt ?? t("none") }),
    t("dispositions", { counts: counts(summary.counts.dispositions) }),
    t("flags", { counts: counts(summary.counts.flags) }),
    t("mismatch", { codes: summary.counts.mismatch?.join(", ") || t("none") }),
  ];
  for (const item of items) {
    lines.push(t("item", { ordinal: item.ordinal, batch: item.batch, disposition: item.disposition, flags: item.flags.join(", ") || t("none"), bytes: item.bytes, hash: item.hashPrefix }));
    if (item.payload) {
      lines.push(t("externalId", { id: item.externalId ?? t("none") }));
      lines.push(item.payload.state === "kept" ? item.payload.text ?? JSON.stringify(item.payload.json) : t("notKept"));
    }
  }
  return { exitCode: 0, output: lines.join("\n") };
}

/** Readiness is injected at the rendering boundary so an upgrade window can be tested without DDL. */
export async function showDeliveries(options: FormatOptions & { runId: number }, reads: {
  tablesReady: () => Promise<boolean>;
  query: (runId: number, payload: boolean) => Promise<DeliveryRunView | null>;
}, t: DeliveryText): Promise<DeliveryOutput> {
  if (!(await reads.tablesReady())) {
    const message = t("notReady");
    return { exitCode: 0, output: options.json ? JSON.stringify({ state: "not_ready", message }) : message };
  }
  return formatDeliveries(await reads.query(options.runId, options.payload), options, t);
}
