import type { ReasonBasis } from "@/lib/ai/prompts/score";
import type { ReasonEvidence, ReasonSource } from "@/lib/scoring/evidence";

/** One reason's source as the detail page shows it: `mark` is the position of its quote in the JD panel's quote list. */
export interface ReasonSourceView {
  basis: ReasonBasis | null;
  /** The JD's own text (only with `jd`). */
  quote: string | null;
  /** Index into the JD panel's `quotes` list of the mark this quote jumps to; null when it has none. */
  mark: number | null;
}

/**
 * The text of a reason quote the JD panel can mark: its first line without a list bullet (the panel marks inside one line, and
 * shows list items without their bullets). Empty when nothing is left.
 */
export function evidenceMarkText(quote: string): string {
  const first = quote.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.trim().replace(/^(?:[-*•]|\d{1,3}[.)])\s+/u, "").trim();
}

/**
 * The reason sources of a score with the JD marks their quotes need. `prior` is the JD panel's list before the reason quotes (signal,
 * breakdown, trap, visa, ghost quotes): a quote with the same text as one of those jumps to that mark, the others get marks of their
 * own (`marks`, appended to the list in this order, each text once). Whether the JD really shows a mark is the caller's check.
 */
export function reasonSourceViews(evidence: ReasonEvidence | null, prior: ReadonlyArray<{ text: string }>): { marks: string[]; fit: ReasonSourceView[]; gaps: ReasonSourceView[] } {
  const marks: string[] = [];
  const markOf = (quote: string | null): number | null => {
    const text = quote === null ? "" : evidenceMarkText(quote);
    if (text === "") return null;
    const earlier = prior.findIndex((q) => q.text === text);
    if (earlier !== -1) return earlier;
    const own = marks.indexOf(text);
    if (own !== -1) return prior.length + own;
    marks.push(text);
    return prior.length + marks.length - 1;
  };
  const view = (source: ReasonSource): ReasonSourceView => (source.basis === "jd" ? { basis: "jd", quote: source.quote, mark: markOf(source.quote) } : { basis: source.basis, quote: null, mark: null });
  if (evidence === null) return { marks, fit: [], gaps: [] };
  return { fit: evidence.fit.map(view), gaps: evidence.gaps.map(view), marks };
}
