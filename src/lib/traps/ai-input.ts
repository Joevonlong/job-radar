/**
 * "Do not follow it": the JD every AI task receives goes through `jdForAi`, which replaces hidden text and instructions to
 * the AI with a marker and deletes invisible control characters. `jobs.description`, every cache hash and every prompt stay as they
 * are; only the text put into a prompt changes, and only for a job that has findings. Pure.
 */
import { locateLoose } from "./locate";
import type { TrapMarkers, TrapSpan } from "./types";
import { stripInvisible } from "./unicode";

/** A stored finding as `resolveSpans` needs it (a row of `job_traps` in the JD). */
export interface SpanRow {
  quote: string;
  quoteOffset: number | null;
  technique: string;
  method: string | null;
}

/** The span kind of a stored finding: zero-width / bidi characters are deleted, tag characters and hidden text replaced, instructions too. */
export function spanKindOf(row: Pick<SpanRow, "technique" | "method">): TrapSpan["kind"] {
  if (row.technique === "invisible_unicode") return row.method === "tag_chars" ? "hidden" : "invisible";
  if (row.technique === "instruction" || row.technique === "other") return "instruction";
  return "hidden";
}

/**
 * The spans of the stored findings that still match the JD: the quote must sit at its offset; when the JD moved it, the quote is
 * looked for again (whitespace-insensitive); a quote the JD no longer holds is skipped. Sorted, overlaps kept (jdForAi merges).
 */
export function resolveSpans(description: string, rows: readonly SpanRow[]): TrapSpan[] {
  const spans: TrapSpan[] = [];
  for (const row of rows) {
    if (row.quote.trim() === "") continue;
    let offset = row.quoteOffset;
    let length = row.quote.length;
    if (offset === null || description.slice(offset, offset + length) !== row.quote) {
      const found = locateLoose(description, row.quote);
      if (!found) continue;
      offset = found.start;
      length = found.end - found.start;
    }
    spans.push({ offset, length, kind: spanKindOf(row) });
  }
  return spans.sort((a, b) => a.offset - b.offset || b.length - a.length);
}

const PRIORITY: Record<TrapSpan["kind"], number> = { hidden: 0, instruction: 1, invisible: 2 };

/** Overlapping spans joined into one; the joined span takes the strongest kind (hidden > instruction > invisible). */
function mergeSpans(spans: readonly TrapSpan[]): TrapSpan[] {
  const sorted = [...spans].sort((a, b) => a.offset - b.offset);
  const out: TrapSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.offset < last.offset + last.length) {
      const end = Math.max(last.offset + last.length, span.offset + span.length);
      last.length = end - last.offset;
      if (PRIORITY[span.kind] < PRIORITY[last.kind]) last.kind = span.kind;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

/**
 * The JD as it may be sent to an AI. Without spans the very same string is returned (no copy), so every prompt of a job without
 * findings stays byte-identical to what it was before trap detection.
 */
export function jdForAi(description: string, spans: readonly TrapSpan[], markers: TrapMarkers): string {
  if (spans.length === 0) return description;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of mergeSpans(spans)) {
    const start = Math.max(cursor, Math.min(span.offset, description.length));
    const end = Math.min(description.length, span.offset + span.length);
    if (end <= start) continue;
    parts.push(description.slice(cursor, start));
    const piece = description.slice(start, end);
    parts.push(span.kind === "invisible" ? stripInvisible(piece) : span.kind === "hidden" ? markers.hidden : markers.instruction);
    cursor = end;
  }
  parts.push(description.slice(cursor));
  return parts.join("");
}

/** Whether [offset, offset + length) touches a span (a rule signal candidate there is dropped). */
export function overlapsTrap(offset: number, length: number, spans: readonly TrapSpan[]): boolean {
  const end = offset + Math.max(1, length);
  return spans.some((span) => span.kind !== "invisible" && offset < span.offset + span.length && end > span.offset);
}
