/**
 * The company background as writing material: only the fields ticked for a question, of the result they were ticked in. It is text an
 * AI found on the web, so it is unverified whatever it says, and the rules here only make it safe to quote: what cannot be told
 * apart from an instruction by a rule is handled by how the prompt quotes it (`COMPANY_DATA_RULE`) and by the evidence check, which
 * lets it back nothing about the applicant. The prompt and the check both see the text made here.
 */
import type { TrapsConfig } from "@/lib/config";
import { COMPANY_RESEARCH_FIELDS, type CompanyResearchField, type CompanyResearchView } from "@/lib/research/fields";
import { firstInstruction } from "@/lib/traps/instructions";
import { stripInvisible } from "@/lib/traps/unicode";

import type { CompanySnapshot } from "./materials";

const FIELD_MAX_CHARS = 5000;
/** `<` and `>` and the commonest characters drawn like them. Not a complete list: there are more, and entities and other delimiters. */
const ANGLE_BRACKETS = /[<>＜＞﹤﹥‹›〈〉《》❮❯⟨⟩]/gu;
/** So a closing tag cannot be spelled with any delimiter: without its name it closes nothing, whatever surrounds it. */
const BLOCK_TAG_NAMES = /company_background|application_input|fit_input/giu;

export function httpsUrlOrNull(url: string | null): string | null {
  if (url === null || !URL.canParse(url)) return null;
  return new URL(url).protocol === "https:" ? url : null;
}

/**
 * The text as it may be quoted: no invisible characters, no tag names, no angle brackets. Names are looked for after folding (NFKC),
 * so a fullwidth or styled spelling counts; text without one keeps its own characters, such as Chinese punctuation.
 */
export function companyFieldText(text: string): string {
  const visible = stripInvisible(text);
  const folded = visible.normalize("NFKC");
  const named = folded.search(BLOCK_TAG_NAMES) === -1 ? visible : folded.replace(BLOCK_TAG_NAMES, " ");
  return named.replace(ANGLE_BRACKETS, " ").trim().slice(0, FIELD_MAX_CHARS);
}

export function companySnapshot(input: {
  research: CompanyResearchView | null;
  selection: { researchId: number; fields: readonly CompanyResearchField[] } | null;
  /** Looks at each field once more, since the rules may be newer than the result. Null: traps.yaml cannot be read. */
  traps: TrapsConfig | null;
}): { snapshot: CompanySnapshot | null; updated: boolean } {
  const { research, selection, traps } = input;
  if (selection === null || selection.fields.length === 0) return { snapshot: null, updated: false };
  // the ticks were made on a text that is gone: ask again rather than send a text nobody chose
  if (research === null || research.id !== selection.researchId) return { snapshot: null, updated: true };
  const ticked = new Set(selection.fields);
  const fields = COMPANY_RESEARCH_FIELDS.flatMap((field) => {
    const entry = research.fields[field];
    if (!ticked.has(field) || !entry) return [];
    const text = companyFieldText(entry.text);
    if (text === "" || (traps !== null && firstInstruction(text, traps) !== null)) return [];
    return [{ field, text, sourceUrl: httpsUrlOrNull(entry.sourceUrl) }];
  });
  return { snapshot: fields.length === 0 ? null : { researchId: research.id, expired: research.expired, fields }, updated: false };
}

/** What a `company` quote is checked against. */
export function companyEvidenceText(company: CompanySnapshot): string {
  return company.fields.map((entry) => entry.text).join("\n");
}
