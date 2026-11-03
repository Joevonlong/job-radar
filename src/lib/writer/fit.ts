/**
 * The check of a "what this means for your application" note, in code, no AI call. A note joins two sources that must stay apart: a
 * fact about the company from unverified web text and something the applicant did. Each half answers only to its own quote, so a
 * phrase like "you hold a PhD from MIT", taken from a web page and cited to anything, cannot pass as the applicant's own.
 */
import { z } from "zod";

import type { TrapsConfig } from "@/lib/config";
import type { WriterEvidenceConfig } from "@/lib/config/schemas/writer";
import { firstInstruction } from "@/lib/traps/instructions";

import { companyEvidenceText } from "./company-background";
import { storyEvidenceText, type CompanySnapshot, type StorySnapshot } from "./materials";
import { containsWords, missingFigures, nameCandidates, normalize } from "./verify";

export const FIT_FLAGS = ["company_quote_not_found", "story_quote_not_found", "unknown_story", "company_point_unbacked", "your_point_unbacked"] as const;
export type FitFlag = (typeof FIT_FLAGS)[number];

export const fitItemSchema = z.strictObject({
  companyPoint: z.string(),
  yourPoint: z.string(),
  companyQuote: z.string(),
  storyRef: z.string(),
  storyQuote: z.string(),
  /** `quotes_found`: both quotes were found and no name or figure of a point is missing from its quote. It says nothing on whether they are true. */
  status: z.enum(["quotes_found", "flagged"]),
  flags: z.array(z.enum(FIT_FLAGS)),
  /** The names and figures of a point that its own quote does not have. */
  missing: z.array(z.string()),
});
export type FitItem = z.infer<typeof fitItemSchema>;

/** Stored items; anything that no longer reads as a list of items shows as none. */
export function parseFitItems(stored: unknown): FitItem[] {
  const parsed = z.array(fitItemSchema).safeParse(stored);
  return parsed.success ? parsed.data : [];
}

export interface FitContext {
  company: CompanySnapshot;
  stories: readonly StorySnapshot[];
  companyName: string;
  language: string;
  evidence: WriterEvidenceConfig;
  traps: TrapsConfig | null;
}

function quoteFound(evidence: string, quote: string, minChars: number): boolean {
  const wanted = normalize(quote);
  return wanted.length >= minChars && normalize(evidence).includes(wanted);
}

function unbacked(point: string, quote: string, context: FitContext, allowed: readonly string[]): string[] {
  const names = nameCandidates(point, context.language, context.evidence).filter((name) => !containsWords(quote, name) && !allowed.some((known) => containsWords(known, name)));
  return [...missingFigures(point, quote, context.evidence.figure_units), ...names];
}

/**
 * Check every item. A flagged item stays, with what was found: the reader decides. An item a rule takes for an instruction is left
 * out, and so is a repeated one.
 */
export function checkFitItems(
  items: readonly { company_point: string; your_point: string; company_quote: string; story_ref: string; story_quote: string }[],
  context: FitContext,
  maxItems: number,
): FitItem[] {
  const companyText = companyEvidenceText(context.company);
  const stories = new Map(context.stories.map((story) => [story.id, storyEvidenceText(story)]));
  const minChars = context.evidence.min_quote_chars;
  const seen = new Set<string>();
  return items
    .flatMap((item) => {
      const key = normalize(`${item.company_point}\n${item.your_point}`);
      if (seen.has(key)) return [];
      seen.add(key);
      const joined = [item.company_point, item.your_point, item.company_quote, item.story_quote].join("\n");
      if (context.traps !== null && firstInstruction(joined, context.traps) !== null) return [];
      const story = stories.get(item.story_ref);
      const flags: FitFlag[] = [];
      if (!quoteFound(companyText, item.company_quote, minChars)) flags.push("company_quote_not_found");
      if (story === undefined) flags.push("unknown_story");
      else if (!quoteFound(story, item.story_quote, minChars)) flags.push("story_quote_not_found");
      const companySide = flags.includes("company_quote_not_found") ? [] : unbacked(item.company_point, item.company_quote, context, [context.companyName]);
      const yourSide = unbacked(item.your_point, story === undefined ? "" : item.story_quote, context, []);
      if (companySide.length > 0) flags.push("company_point_unbacked");
      if (yourSide.length > 0) flags.push("your_point_unbacked");
      return [
        {
          companyPoint: item.company_point,
          yourPoint: item.your_point,
          companyQuote: item.company_quote,
          storyRef: item.story_ref,
          storyQuote: item.story_quote,
          status: flags.length === 0 ? ("quotes_found" as const) : ("flagged" as const),
          flags,
          missing: [...new Set([...companySide, ...yourSide])],
        },
      ];
    })
    .slice(0, maxItems);
}

/** The applicant's own words, the only part of a note that may go into the emphasis note: that note counts as their word. */
export function emphasisFromFit(item: FitItem): string | null {
  return item.status === "quotes_found" ? item.storyQuote : null;
}

export function appendToEmphasis(current: string, addition: string, maxChars: number): string | null {
  const trimmed = current.trim();
  if (normalize(trimmed).includes(normalize(addition))) return current;
  const next = trimmed === "" ? addition : `${trimmed}\n${addition}`;
  return next.length > maxChars ? null : next;
}
