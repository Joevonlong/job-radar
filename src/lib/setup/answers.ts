/**
 * The answers file of `pnpm run setup --answers <file.yaml>` (unattended setup). Validated with zod (C6), then
 * converted into the inputs the wizard's step services take, so the command line and the web write the same files.
 * Every section is optional: a missing section is recorded as skipped. Omitted fields keep what the files say now.
 */
import { z } from "zod";

import { LOCALES } from "@/i18n/locale";
import { AI_PROVIDER_IDS, AI_PROVIDER_KINDS } from "@/lib/config/ai-options";
import { CONTRACT_OPTIONS, LANGUAGE_LEVEL_OPTIONS, SENIORITY_OPTIONS, WORKPLACE_OPTIONS, type MeDraft } from "@/lib/profile/draft";

import type { AiInput, LanguageInput, MarketInput, SourcesInput, TargetsInput, TelegramInput } from "./inputs";

const text = z.string().max(500);
const names = z.array(z.string().max(200)).max(200);

const regionScope = z.strictObject({ region: z.array(z.string().max(40)).min(1).max(50) });

export const answersSchema = z.strictObject({
  language: z.strictObject({ ui_locale: z.enum(LOCALES), ai_output: z.string().max(35).optional(), translation_target: z.string().max(35).optional() }).optional(),
  market: z
    .strictObject({
      pack: z.string().max(40),
      country: z.string().max(10).optional(),
      currency: z.string().max(10).optional(),
      home_language: z.string().max(10).optional(),
      locations: names.optional(),
      /** `none` | `home_country` | `worldwide` | `{ region: [eu, CH] }` (as in preferences.yaml). */
      remote_scope: z.union([z.enum(["none", "home_country", "worldwide"]), regionScope]).optional(),
      timezone: z.string().max(100).optional(),
    })
    .optional(),
  profile: z
    .strictObject({
      summary: z.string().max(4000).optional(),
      /** `Python` or `{ name: Python, years: 5 }`. */
      skills: z.array(z.union([z.string().max(200), z.strictObject({ name: z.string().max(200), years: z.number().min(0).nullable().optional() })])).max(200).optional(),
      /** Language code -> level, e.g. `{ en: C1, de: B1 }`. */
      languages: z.record(z.string().max(3), z.enum(LANGUAGE_LEVEL_OPTIONS)).optional(),
      years_experience: z.number().min(0).nullable().optional(),
      city: text.optional(),
      needs_visa_sponsorship: z.boolean().optional(),
    })
    .optional(),
  targets: z
    .strictObject({
      target_titles: names.optional(),
      seniority: z.enum(SENIORITY_OPTIONS).optional(),
      workplace: z.array(z.enum(WORKPLACE_OPTIONS)).optional(),
      salary_floor_year: z.number().int().min(0).optional(),
      contracts: z.strictObject({ allow: z.array(z.enum(CONTRACT_OPTIONS)).default([]), exclude: z.array(z.enum(CONTRACT_OPTIONS)).default([]) }).optional(),
      exclude_student_roles: z.boolean().optional(),
      exclude_companies: names.optional(),
      exclude_keywords: names.optional(),
    })
    .optional(),
  sources: z
    .strictObject({
      enable: z.array(z.string().max(100)).max(50).default([]),
      disable: z.array(z.string().max(100)).max(50).default([]),
      boards: z.array(z.strictObject({ name: z.string().max(200), ats: z.string().max(40), token: z.string().max(200) })).max(50).default([]),
      /** Confirms the terms-of-service notice for the scraping / account channels in `enable` (see docs/sources.md). */
      acknowledge_scraping: z.boolean().default(false),
    })
    .optional(),
  ai: z
    .strictObject({
      order: z.array(z.enum(AI_PROVIDER_KINDS)).max(AI_PROVIDER_KINDS.length).optional(),
      providers: z.partialRecord(z.enum(AI_PROVIDER_IDS), z.strictObject({ enabled: z.boolean(), model: z.string().max(200).optional(), strong_model: z.string().max(200).optional() })).default({}),
    })
    .optional(),
  telegram: z.strictObject({ enabled: z.boolean(), notify_locale: z.enum(LOCALES).nullable().optional() }).optional(),
  /** After the steps: mark the setup complete (default yes) and queue the first cycle (default no; needs the database). */
  finish: z.strictObject({ complete: z.boolean().default(true), run_first_cycle: z.boolean().default(false) }).default({ complete: true, run_first_cycle: false }),
});

export type SetupAnswers = z.infer<typeof answersSchema>;

export type AnswersParse = { ok: true; answers: SetupAnswers } | { ok: false; issues: Array<{ path: string; message: string }> };

export function parseAnswers(raw: unknown): AnswersParse {
  const parsed = answersSchema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, answers: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message })) };
}

// ---------------------------------------------------------------- answers -> step inputs (current values fill the gaps)

export function languageInputOf(answers: NonNullable<SetupAnswers["language"]>): LanguageInput {
  return { ui_locale: answers.ui_locale, ...(answers.ai_output !== undefined ? { ai_output: answers.ai_output } : {}), ...(answers.translation_target !== undefined ? { translation_target: answers.translation_target } : {}) };
}

export function marketInputOf(answers: NonNullable<SetupAnswers["market"]>, current: MarketInput): MarketInput {
  const scope = answers.remote_scope;
  return {
    market: { pack: answers.pack, country: answers.country ?? "", currency: answers.currency ?? "", home_language: answers.home_language ?? "" },
    locations: answers.locations ?? current.locations,
    remote_scope: scope === undefined ? current.remote_scope : typeof scope === "string" ? scope : `region:${scope.region.join(",")}`,
    timezone: answers.timezone ?? current.timezone,
  };
}

export function profileInputOf(answers: NonNullable<SetupAnswers["profile"]>, current: MeDraft): MeDraft {
  const years = (value: number | null | undefined): string => (value === null || value === undefined ? "" : String(value));
  return {
    summary: answers.summary ?? current.summary,
    skills: answers.skills === undefined ? current.skills : answers.skills.map((skill) => (typeof skill === "string" ? { name: skill, years: "" } : { name: skill.name, years: years(skill.years) })),
    languages: answers.languages === undefined ? current.languages : Object.entries(answers.languages).map(([code, level]) => ({ code, level })),
    years_experience: answers.years_experience === undefined ? current.years_experience : years(answers.years_experience),
    city: answers.city ?? current.city,
    needs_visa_sponsorship: answers.needs_visa_sponsorship ?? current.needs_visa_sponsorship,
  };
}

export function targetsInputOf(answers: NonNullable<SetupAnswers["targets"]>, current: TargetsInput): TargetsInput {
  const contracts = answers.contracts === undefined ? current.contracts : Object.fromEntries(CONTRACT_OPTIONS.map((kind) => [kind, answers.contracts?.allow.includes(kind) ? "allow" : answers.contracts?.exclude.includes(kind) ? "exclude" : "none"]));
  return {
    target_titles: answers.target_titles ?? current.target_titles,
    seniority: answers.seniority ?? current.seniority,
    workplace: answers.workplace ?? current.workplace,
    salary_floor_year: answers.salary_floor_year === undefined ? current.salary_floor_year : String(answers.salary_floor_year),
    contracts,
    exclude_student_roles: answers.exclude_student_roles ?? current.exclude_student_roles,
    exclude_companies: answers.exclude_companies ?? current.exclude_companies,
    exclude_keywords: answers.exclude_keywords ?? current.exclude_keywords,
  };
}

export function sourcesInputOf(answers: NonNullable<SetupAnswers["sources"]>): SourcesInput {
  return { channels: Object.fromEntries([...answers.enable.map((id) => [id, true] as const), ...answers.disable.map((id) => [id, false] as const)]), boards: answers.boards, acknowledge: answers.acknowledge_scraping };
}

export function aiInputOf(answers: NonNullable<SetupAnswers["ai"]>): AiInput {
  return { ...(answers.order !== undefined ? { order: answers.order } : {}), providers: answers.providers };
}

export function telegramInputOf(answers: NonNullable<SetupAnswers["telegram"]>): TelegramInput {
  return { enabled: answers.enabled, ...(answers.notify_locale !== undefined ? { notify_locale: answers.notify_locale } : {}) };
}
