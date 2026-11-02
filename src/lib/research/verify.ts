/**
 * The code-side check of a company background. The answer is untrusted (the model read web pages, and other AI tasks
 * read the stored result), so each field stands alone: it needs a public https source, no invisible characters, nothing
 * written at an AI, and plausible numbers. A field that fails is dropped and counted. Only what is left is stored.
 */
import type { CompanyResearchOutput } from "@/lib/ai/prompts/company-research";
import type { ResearchConfig } from "@/lib/config";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { CompanyResearchResult } from "@/lib/db/repos/company-research";
import { publicHttpsUrl } from "@/lib/salary/lookup-verify";
import { firstInstruction } from "@/lib/traps/instructions";
import { stripInvisible } from "@/lib/traps/unicode";

import { COMPANY_RESEARCH_FIELDS, type CompanyResearchField } from "./fields";

export interface CompanyResearchVerifyInput {
  output: CompanyResearchOutput;
  limits: Pick<ResearchConfig["company"], "max_field_chars" | "employees" | "rating">;
  /** traps.yaml: its instruction patterns are the check, whether or not the trap scan of postings is switched on. */
  traps: TrapsConfig;
  now: Date;
}

/** Tag characters and other invisible marks `stripInvisible` leaves alone (it keeps what real text in other languages needs in a JD). */
const OTHER_INVISIBLE = /[­͏؜᠎‎‏⁡-⁤\u{E0000}-\u{E007F}]/u;
/** A date as a source states it: a year, a month or a day. */
const PARTIAL_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const hasInvisible = (text: string): boolean => stripInvisible(text) !== text || OTHER_INVISIBLE.test(text);

const decoded = (url: string): string => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

/** Written at an AI, however it is spelled: compatibility forms folded, line breaks closed. */
const hasInstruction = (text: string, traps: TrapsConfig): boolean => firstInstruction(text.normalize("NFKC").replace(/\s+/g, " "), traps) !== null;

const singleLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The stored text: plain, on one line, except that the items of a list field stay on lines of their own. */
function cleanText(text: string, field: CompanyResearchField): string {
  if (field !== "recentNews") return singleLine(text);
  return text
    .split(/\r?\n/)
    .map(singleLine)
    .filter((line) => line !== "")
    .join("\n");
}

const inRange = (value: number, range: { min: number; max: number }): boolean => value >= range.min && value <= range.max;

/** The numbers beside the text: a value that cannot be right takes the field with it. Null is simply not stated. */
function plausible(field: CompanyResearchField, output: CompanyResearchOutput, input: CompanyResearchVerifyInput): boolean {
  switch (field) {
    case "size":
      return output.size?.employees == null || inRange(output.size.employees, input.limits.employees);
    case "founded":
      return output.founded?.year == null || (Number.isInteger(output.founded.year) && output.founded.year > 0 && output.founded.year <= input.now.getUTCFullYear());
    case "reviews":
      return output.reviews?.rating == null || inRange(output.reviews.rating, input.limits.rating);
    case "recentNews": {
      const date = output.recentNews?.date;
      if (date == null) return true;
      if (!PARTIAL_DATE.test(date)) return false;
      return date <= input.now.toISOString().slice(0, date.length);
    }
    default:
      return true;
  }
}

export function verifyCompanyResearch(input: CompanyResearchVerifyInput): CompanyResearchResult {
  const fields: CompanyResearchResult["fields"] = {};
  let dropped = 0;
  for (const field of COMPANY_RESEARCH_FIELDS) {
    const raw = input.output[field];
    if (raw === null) continue;
    if (raw.text.trim() === "") continue;
    const source = raw.source_url === null ? null : publicHttpsUrl(raw.source_url);
    const sourceText = source === null ? "" : decoded(source.href);
    if (source === null || hasInvisible(raw.text) || hasInvisible(sourceText) || hasInstruction(raw.text, input.traps) || hasInstruction(sourceText, input.traps) || !plausible(field, input.output, input)) {
      dropped += 1;
      continue;
    }
    const text = clip(cleanText(raw.text, field), input.limits.max_field_chars);
    if (text === "") continue;
    fields[field] = { text, sourceUrl: source.href };
  }
  return { fields, dropped };
}
