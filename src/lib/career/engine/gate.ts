import { LETTER_PAGES, letterPlaceholders } from "./letter-check";
import { type Issue, placeholderIssues } from "./lint";
import type { Doc } from "./render";
import type { Resume } from "./schema";

export const unfinished = (r: Resume, doc: Doc): Issue[] => (doc === "letter" ? letterPlaceholders(r) : placeholderIssues(r));

export const pageBudget = (r: Resume, doc: Doc) => (doc === "letter" ? LETTER_PAGES : r.meta.pages);

export function shipBlockers(r: Resume, doc: Doc, pages?: number): string[] {
  const out: string[] = [];
  const left = unfinished(r, doc);
  if (left.length) {
    const where = left.slice(0, 3).map((i) => i.where).join(", ") + (left.length > 3 ? ", …" : "");
    out.push(`${left.length} unfinished placeholder${left.length === 1 ? "" : "s"} (${where})`);
  }
  const budget = pageBudget(r, doc);
  if (pages !== undefined && pages > budget) out.push(`${pages} pages, over the budget of ${budget}`);
  return out;
}
