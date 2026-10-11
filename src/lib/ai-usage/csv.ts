/** CSV export of the call log of /sources/ai-usage. */
import type { AiUsageCall } from "@/lib/db/queries/ai-usage";

export const AI_USAGE_CSV_HEADER = [
  "at", "task", "provider", "model", "model_source", "outcome", "error_kind", "tokens_in", "tokens_in_cached", "tokens_in_cache_write",
  "tokens_out", "tokens_out_reasoning", "duration_ms", "equivalent_usd", "actual_usd", "job_id", "job_title",
] as const;

/** A text cell that starts with one of these is a formula to Excel, Numbers and LibreOffice. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * RFC 4180: a field with a comma, quote or line break is quoted and its quotes doubled. A TEXT that starts with `= + - @`,
 * a tab or a carriage return gets a leading `'` (OWASP, CSV injection): job titles come from scraped third-party postings
 * and must never be executed as a formula. Numbers are written as they are (a negative number stays a number).
 */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  const text = typeof value === "string" && FORMULA_START.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** ISO 8601 with the offset of `timeZone` (2026-10-07T14:03:12+02:00). */
export function isoInZone(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMin = Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** UTF-8 BOM first so a spreadsheet opens it as UTF-8; unknown values are empty cells. */
export function aiUsageCsv(rows: readonly AiUsageCall[], timeZone: string): string {
  const lines = [AI_USAGE_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        isoInZone(r.at, timeZone), r.task, r.provider, r.model, r.modelSource, r.outcome, r.errorKind, r.tokensIn, r.tokensInCached, r.tokensInCacheWrite,
        r.tokensOut, r.tokensOutReasoning, r.durationMs, r.equivalentUsd, r.costUsd, r.job?.id ?? null, r.job?.title ?? null,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
