/**
 * The breakdown card's view model: a pure function from the stored row, the JD, the signal quotes and the profile
 * to something a client component can render (serializable). Grouping, ordering, quote jump indexes, the staleness marks
 * and the "have / missing" comparison (C5: done here, locally, never by the AI) all happen here.
 */
import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { quotesFoundInJd } from "@/lib/dashboard/jd";
import { profileSkillKeys, skillKey } from "@/lib/dashboard/skills";
import type { JobBreakdownRow } from "@/lib/db/repos/breakdowns";
import { resolveShownModel, type ModelsConfig } from "@/lib/config";
import { descriptionHash } from "@/lib/translation/hash";

import { countItems, parseStoredBreakdown, type BreakdownContent } from "./content";
import { TECH_CATEGORIES, type RequirementLevel, type SpokenLevel, type TechCategory } from "./constants";
import { sameLanguage } from "@/lib/i18n/languages";

export interface BreakdownQuote {
  quote: string;
  /** Mark index in the JD panel's quote list; null = no highlight to jump to. */
  quoteIndex: number | null;
}
export interface BreakdownViewItem extends BreakdownQuote {
  text: string;
  requirement: RequirementLevel | null;
}
export interface BreakdownViewTech extends BreakdownQuote {
  name: string;
  category: TechCategory;
  requirement: RequirementLevel;
  /** null: the profile has no skills. */
  have: boolean | null;
}
export interface BreakdownView {
  meta: {
    provider: string | null;
    model: string | null;
    /** The model is the catalog's CLI default (codex without an explicit model). */
    modelByCliDefault: boolean;
    promptVersion: string;
    analyzedAt: string;
    dropped: number;
    /** The language the items are written in (its BCP 47 tag goes into `lang`). */
    outputLang: string;
  };
  /** `lang`: written in another language than `language.yaml: ai.output` now says; breaking it down again rewrites it. */
  stale: { jd: boolean; prompt: boolean; lang: boolean };
  /** null: stored in a format this version cannot read (show "outdated"). */
  content: null | {
    total: number;
    responsibilities: BreakdownViewItem[];
    /** TECH_CATEGORIES order, empty groups left out, must before nice. */
    techGroups: Array<{ category: TechCategory; items: BreakdownViewTech[] }>;
    experience: { yearsMin: number | null; years: BreakdownQuote | null; items: BreakdownViewItem[] };
    projects: BreakdownViewItem[];
    softSkills: BreakdownViewItem[];
    other: BreakdownViewItem[];
    languages: Array<BreakdownViewItem & { language: string; level: SpokenLevel }>;
  };
  /** "none": me.yaml lists no skills (the card links to /me). */
  match:
    | { state: "none" }
    | {
        state: "ok";
        must: { have: number; total: number };
        nice: { have: number; total: number };
        /** Missing tech items, must first. */
        missing: BreakdownViewTech[];
        /** Present when the JD states minimum years. `ok` null: the profile has no years. */
        years: { required: number; mine: number | null; ok: boolean | null } | null;
      };
}

export interface BuildBreakdownViewInput {
  row: JobBreakdownRow | null;
  description: string | null;
  /** The signal quotes the JD panel already highlights, in order (they keep indexes 0..n-1). */
  signalQuotes: readonly string[];
  profileSkills: readonly string[];
  profileYears: number | null;
  aliases: ReadonlyMap<string, string>;
  /** Model catalog: rows that stored codex's "codex-default" placeholder show the catalog's CLI default model. */
  catalog?: ModelsConfig | null;
  /** The configured AI output language; a breakdown in another one is marked (null: not checked). */
  outputLang?: string | null;
}

const mustFirst = <T extends { requirement: RequirementLevel | null }>(items: readonly T[]): T[] => [...items.filter((i) => i.requirement !== "nice"), ...items.filter((i) => i.requirement === "nice")];

function collectQuotes(content: BreakdownContent): string[] {
  const quotes: string[] = [];
  for (const i of content.responsibilities) quotes.push(i.quote);
  for (const i of content.tech_stack) quotes.push(i.quote);
  if (content.experience.years_quote) quotes.push(content.experience.years_quote.quote);
  for (const i of content.experience.items) quotes.push(i.quote);
  for (const i of content.projects) quotes.push(i.quote);
  for (const i of content.soft_skills) quotes.push(i.quote);
  for (const i of content.languages) quotes.push(i.quote);
  for (const i of content.other) quotes.push(i.quote);
  return quotes;
}

export function buildBreakdownView(input: BuildBreakdownViewInput): { view: BreakdownView | null; extraQuotes: string[] } {
  const { row } = input;
  if (row === null) return { view: null, extraQuotes: [] };
  const shown = resolveShownModel(input.catalog ?? null, row.provider, row.model);
  const meta = { provider: row.provider, model: shown.model, modelByCliDefault: shown.byCliDefault, promptVersion: row.promptVersion, analyzedAt: row.analyzedAt.toISOString(), dropped: row.droppedItems, outputLang: row.outputLang };
  const stale = {
    jd: row.sourceHash !== descriptionHash(input.description),
    prompt: row.promptVersion !== BREAKDOWN_PROMPT_VERSION,
    lang: input.outputLang !== undefined && input.outputLang !== null && !sameLanguage(row.outputLang, input.outputLang),
  };
  const stored = parseStoredBreakdown(row.promptVersion, row.content);
  if (stored === null) {
    return { view: { meta, stale, content: null, match: { state: "none" } }, extraQuotes: [] };
  }

  // Quote indexes: a quote equal to a signal quote reuses that mark; the others are appended once each (the JD panel
  // highlights the first occurrence of a text only, so duplicates must share one mark).
  const indexOf = new Map<string, number>();
  input.signalQuotes.forEach((quote, index) => {
    if (!indexOf.has(quote)) indexOf.set(quote, index);
  });
  const extraQuotes: string[] = [];
  for (const quote of collectQuotes(stored)) {
    if (indexOf.has(quote)) continue;
    indexOf.set(quote, input.signalQuotes.length + extraQuotes.length);
    extraQuotes.push(quote);
  }
  const found = quotesFoundInJd(input.description, [...input.signalQuotes, ...extraQuotes]);
  const jump = (quote: string): BreakdownQuote => {
    const index = indexOf.get(quote);
    return { quote, quoteIndex: index !== undefined && found[index] === true ? index : null };
  };

  const keys = profileSkillKeys(input.profileSkills, input.aliases);
  const hasProfileSkills = input.profileSkills.length > 0;
  const tech: BreakdownViewTech[] = stored.tech_stack.map((entry) => {
    const key = skillKey(entry.name);
    return { name: entry.name, category: entry.category, requirement: entry.requirement, ...jump(entry.quote), have: hasProfileSkills ? keys.has(input.aliases.get(key) ?? key) : null };
  });
  const techGroups = TECH_CATEGORIES.map((category) => ({ category, items: mustFirst(tech.filter((t) => t.category === category)) })).filter((group) => group.items.length > 0);

  const item = (entry: { text: string; quote: string; requirement?: RequirementLevel }): BreakdownViewItem => ({ text: entry.text, requirement: entry.requirement ?? null, ...jump(entry.quote) });

  const content: NonNullable<BreakdownView["content"]> = {
    total: countItems(stored),
    responsibilities: stored.responsibilities.map(item),
    techGroups,
    experience: {
      yearsMin: stored.experience.years_min,
      years: stored.experience.years_quote ? jump(stored.experience.years_quote.quote) : null,
      items: mustFirst(stored.experience.items.map(item)),
    },
    projects: mustFirst(stored.projects.map(item)),
    softSkills: mustFirst(stored.soft_skills.map(item)),
    other: mustFirst(stored.other.map(item)),
    languages: mustFirst(stored.languages.map((entry) => ({ ...jump(entry.quote), text: entry.language, requirement: entry.requirement, language: entry.language, level: entry.level }))),
  };

  let match: BreakdownView["match"] = { state: "none" };
  if (hasProfileSkills) {
    const count = (level: RequirementLevel) => {
      const items = tech.filter((t) => t.requirement === level);
      return { have: items.filter((t) => t.have === true).length, total: items.length };
    };
    const required = stored.experience.years_min;
    match = {
      state: "ok",
      must: count("must"),
      nice: count("nice"),
      missing: mustFirst(tech.filter((t) => t.have === false)),
      years: required === null ? null : { required, mine: input.profileYears, ok: input.profileYears === null ? null : input.profileYears >= required },
    };
  }
  return { view: { meta, stale, content, match }, extraQuotes };
}
