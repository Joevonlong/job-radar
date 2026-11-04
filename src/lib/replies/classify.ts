import type { RepliesConfig } from "@/lib/config/schemas/replies";
import { sentenceOf } from "@/lib/traps/instructions";

import type { ReplyCategory } from "./types";

type RuleCategory = Exclude<ReplyCategory, "unclassified">;
const RULE_CATEGORIES: readonly RuleCategory[] = ["interview_invite", "rejection", "offer", "info_request", "acknowledgement", "other"];

const compiled = new Map<string, RegExp>();
function regexOf(source: string): RegExp {
  let regex = compiled.get(source);
  if (!regex) {
    regex = new RegExp(source, "iu");
    compiled.set(source, regex);
  }
  return regex;
}

export interface Classification {
  category: ReplyCategory;
  /** The body sentence that decided it; null when the subject decided it or nothing did. */
  evidence: string | null;
}

/**
 * The rule layer: a category counts when one of its strong patterns (any language) hits the subject or the body and none of its
 * exclude patterns hits either. Exactly one such category decides; none or several give `unclassified`, and the user picks with one click.
 */
export function classifyReply(input: { subject: string; body: string }, categories: RepliesConfig["categories"], quoteMaxChars: number): Classification {
  const hits: Array<{ category: RuleCategory; evidence: string | null }> = [];
  for (const category of RULE_CATEGORIES) {
    const groups = Object.values(categories[category]);
    const excluded = groups.some((group) => group.exclude.some((source) => regexOf(source).test(input.subject) || regexOf(source).test(input.body)));
    if (excluded) continue;
    const inSubject = groups.some((group) => group.subject.some((source) => regexOf(source).test(input.subject)));
    let evidence: string | null = null;
    for (const group of groups) {
      for (const source of group.body) {
        const found = regexOf(source).exec(input.body);
        if (found) {
          evidence = sentenceOf(input.body, { start: found.index, end: found.index + found[0].length }, quoteMaxChars).quote.trim();
          break;
        }
      }
      if (evidence !== null) break;
    }
    if (inSubject || evidence !== null) hits.push({ category, evidence });
  }
  const [only, second] = hits;
  if (!only || second) return { category: "unclassified", evidence: null };
  return only;
}

/** The sentence shown with a reply: what decided it, else the start of the mail. */
export function quoteOf(evidence: string | null, body: string, maxChars: number): string | null {
  const text = (evidence ?? body.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
  if (text === "") return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
