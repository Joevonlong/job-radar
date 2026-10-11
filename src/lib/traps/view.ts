/**
 * What the detail page shows of a job's AI traps: the panel's items (traps first, then suspicious findings, in JD order),
 * the harmless hidden texts apart, the counts of the panel heading and of the checks row. Pure: the page passes the stored rows.
 */
import { spanKindOf } from "./ai-input";
import { TRAP_AI_VERDICTS, TRAP_TECHNIQUES, type TrapAiVerdict, type TrapTechnique } from "./types";

/** A stored finding as the view needs it (`listTrapsOfJob` rows fit). */
export interface TrapViewRow {
  id: number;
  layer: "rule" | "ai";
  technique: string;
  method: string | null;
  severity: "trap" | "suspicious";
  quote: string;
  quoteSource: "description" | "raw";
  quoteOffset: number | null;
  location: string;
  evidence: string | null;
  detail: unknown;
  aiVerdict: string | null;
  reason: string | null;
  channelId: string | null;
}

/** A scan row as the view needs it. */
export interface TrapScanView {
  descriptionHash: string;
  foundAt: Date | null;
  aiDescriptionHash: string | null;
  aiCheckedAt: Date | null;
}

export type TrapLocationView =
  | { kind: "description"; line: number }
  | { kind: "raw"; channelId: string | null; field: string; attribute: string | null; comment: boolean };

export interface TrapItemView {
  id: number;
  /** After the AI's judgement: a confirmed suspicious finding is a trap. */
  severity: "trap" | "suspicious";
  technique: TrapTechnique;
  method: string | null;
  /** The text to show: the quote, or the decoded text of tag characters. */
  text: string;
  decoded: boolean;
  source: "rule" | "ai" | "rule_ai";
  verdict: TrapAiVerdict | null;
  reason: string | null;
  location: TrapLocationView;
  evidence: string | null;
  /** The text the JD panel marks for this finding (its first line); null when it cannot be shown there. */
  markText: string | null;
  markKind: "hidden" | "instruction";
}

export interface TrapPanelView {
  /** Traps and suspicious findings. */
  items: TrapItemView[];
  /** Hidden texts the AI judged harmless. */
  benign: TrapItemView[];
  counts: { total: number; rule: number; ai: number; traps: number };
  /** The score was made before the trap was found, while it was in the JD. */
  scoredBeforeFound: boolean;
  /** What the panel's wording follows. `trap` = at least one confirmed trap; `suspicious` = only unconfirmed suspicious findings; `harmless` = everything was judged harmless by the AI. */
  outcome: "trap" | "suspicious" | "harmless";
}

/** The checks row of the detail page: not scanned, nothing found, or N findings (traps and suspicious ones). */
export interface TrapCheckView {
  state: "not_scanned" | "none" | "found";
  count: number;
  aiChecked: boolean;
}

const asTechnique = (value: string): TrapTechnique => (TRAP_TECHNIQUES as readonly string[]).includes(value) ? (value as TrapTechnique) : "other";
const asVerdict = (value: string | null): TrapAiVerdict | null => (value !== null && (TRAP_AI_VERDICTS as readonly string[]).includes(value) ? (value as TrapAiVerdict) : null);

function decodedOf(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as Record<string, unknown>).decoded;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function locationOf(row: TrapViewRow, description: string | null): TrapLocationView {
  if (row.quoteSource === "description" && row.quoteOffset !== null && description !== null) {
    return { kind: "description", line: description.slice(0, row.quoteOffset).split("\n").length };
  }
  const raw = row.location.replace(/^raw:/, "");
  const comment = raw.endsWith("#comment");
  const [field, attribute] = raw.replace(/#comment$/, "").split("@");
  return { kind: "raw", channelId: row.channelId, field: field ?? raw, attribute: attribute ?? null, comment };
}

function toItem(row: TrapViewRow, description: string | null): TrapItemView {
  const verdict = asVerdict(row.aiVerdict);
  const technique = asTechnique(row.technique);
  const decoded = decodedOf(row.detail);
  const inJd = row.quoteSource === "description" && row.quoteOffset !== null;
  const firstLine = row.quote.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? null;
  return {
    id: row.id,
    severity: row.severity === "trap" || verdict === "confirmed" ? "trap" : "suspicious",
    technique,
    method: row.method,
    text: decoded ?? row.quote,
    decoded: decoded !== null,
    source: row.layer === "ai" ? "ai" : verdict === "confirmed" ? "rule_ai" : "rule",
    verdict,
    reason: row.reason,
    location: locationOf(row, description),
    evidence: row.evidence,
    // invisible characters show nothing to mark
    markText: inJd && technique !== "invisible_unicode" ? firstLine : null,
    markKind: spanKindOf(row) === "instruction" ? "instruction" : "hidden",
  };
}

const order = (a: TrapItemView, b: TrapItemView, offsets: Map<number, number>): number =>
  (a.severity === "trap" ? 0 : 1) - (b.severity === "trap" ? 0 : 1) || (offsets.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (offsets.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id - b.id;

/** The panel of a job; null when nothing was found (the panel is then not shown). */
export function buildTrapPanelView(input: { rows: readonly TrapViewRow[]; scan: TrapScanView | null; description: string | null; scoredAt: Date | null }): TrapPanelView | null {
  if (input.rows.length === 0) return null;
  const offsets = new Map(input.rows.map((row) => [row.id, row.quoteOffset ?? Number.MAX_SAFE_INTEGER]));
  const all = input.rows.map((row) => toItem(row, input.description));
  const benign = all.filter((item) => item.verdict === "benign").sort((a, b) => order(a, b, offsets));
  const items = all.filter((item) => item.verdict !== "benign").sort((a, b) => order(a, b, offsets));
  const foundAt = input.scan?.foundAt ?? null;
  return {
    items,
    benign,
    counts: {
      total: items.length,
      rule: items.filter((item) => item.source !== "ai").length,
      ai: items.filter((item) => item.source === "ai").length,
      traps: items.filter((item) => item.severity === "trap").length,
    },
    // The score hint only concerns traps that were taken out of the AI text; harmless / merely suspicious findings were not
    scoredBeforeFound:
      foundAt !== null &&
      input.scoredAt !== null &&
      input.scoredAt.getTime() < foundAt.getTime() &&
      items.some((item) => item.severity === "trap" && item.location.kind === "description"),
    outcome: items.some((item) => item.severity === "trap") ? "trap" : items.length > 0 ? "suspicious" : "harmless",
  };
}

export function buildTrapCheckView(scan: TrapScanView | null, panel: TrapPanelView | null): TrapCheckView {
  if (scan === null) return { state: "not_scanned", count: 0, aiChecked: false };
  const aiChecked = scan.aiCheckedAt !== null && scan.aiDescriptionHash === scan.descriptionHash;
  const count = panel?.counts.total ?? 0;
  return { state: count > 0 ? "found" : "none", count, aiChecked };
}
