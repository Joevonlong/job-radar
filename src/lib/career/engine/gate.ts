import type { Diagnostic, Issue } from "./finding";
import { letterPlaceholders } from "./letter-check";
import type { CheckLimits } from "./limits";
import { placeholderIssues } from "./lint";
import type { Doc } from "./render";
import type { Resume } from "./schema";

export const unfinished = (r: Resume, doc: Doc): Issue[] => (doc === "letter" ? letterPlaceholders(r) : placeholderIssues(r));

export const pageBudget = (r: Resume, doc: Doc, limits: CheckLimits) => (doc === "letter" ? limits.letterPages : r.meta.pages);

export function shipBlockers(r: Resume, doc: Doc, opts: { limits: CheckLimits; pages?: number }): Diagnostic[] {
  const out: Diagnostic[] = [];
  const left = unfinished(r, doc);
  if (left.length) {
    const where = left.slice(0, 3).map((i) => i.where).join(", ");
    out.push({ code: "career.gate.placeholders", params: { count: left.length, where, ...(left.length > 3 ? { more: left.length - 3 } : {}) } });
  }
  const budget = pageBudget(r, doc, opts.limits);
  if (opts.pages !== undefined && opts.pages > budget) out.push({ code: "career.gate.pages", params: { pages: opts.pages, budget } });
  return out;
}
