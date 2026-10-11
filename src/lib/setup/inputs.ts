/**
 * What each step accepts (C6). These are the shapes the wizard's forms send; `pnpm run setup --answers` converts
 * its friendlier file format (answers.ts) into them. Pure zod, no server imports: the browser imports the types.
 */
import { z } from "zod";

import { LOCALES } from "@/i18n/locale";
import { AI_PROVIDER_IDS, AI_PROVIDER_KINDS } from "@/lib/config/ai-options";
import { meDraftSchema } from "@/lib/profile/draft";

const text = (max: number) => z.string().max(max);
const list = (max: number, itemMax = 200) => z.array(text(itemMax)).max(max);

export const languageInputSchema = z.strictObject({
  /** Interface language (a messages file). */
  ui_locale: z.enum(LOCALES),
  /** Language of the AI's texts (language.yaml `ai.output`, a language code such as en, de, pt-BR). */
  ai_output: text(35).optional(),
  /** Target language of job ad translations (language.yaml `translation.target`). */
  translation_target: text(35).optional(),
});
export type LanguageInput = z.infer<typeof languageInputSchema>;

export const marketInputSchema = z.strictObject({
  market: z.strictObject({ pack: text(40), country: text(10), currency: text(10), home_language: text(10) }),
  locations: list(50),
  /** The remote scope key of the profile form: `none`, `home_country`, `worldwide` or `region:eu,CH`. */
  remote_scope: text(500),
  /** IANA time zone of the schedule. */
  timezone: text(100),
});
export type MarketInput = z.infer<typeof marketInputSchema>;

export const profileInputSchema = meDraftSchema;
export type ProfileInput = z.infer<typeof profileInputSchema>;

export const targetsInputSchema = z.strictObject({
  target_titles: list(50),
  seniority: text(20),
  workplace: list(3, 20),
  salary_floor_year: text(20),
  /** Contract kind -> `allow` | `exclude` | `none`. */
  contracts: z.record(text(30), text(20)),
  exclude_student_roles: z.boolean(),
  exclude_companies: list(200),
  exclude_keywords: list(200),
});
export type TargetsInput = z.infer<typeof targetsInputSchema>;

export const boardInputSchema = z.strictObject({ name: text(200), ats: text(40), token: text(200) });
export type BoardInput = z.infer<typeof boardInputSchema>;

export const sourcesInputSchema = z.strictObject({
  /** Channel id -> on / off; channels not listed stay as they are. */
  channels: z.record(text(100), z.boolean()),
  /** Company career boards (ATS) to add. */
  boards: z.array(boardInputSchema).max(50).default([]),
  /** The user has read the terms-of-service notice of the scraping / account channels they switch on. */
  acknowledge: z.boolean().default(false),
});
export type SourcesInput = z.infer<typeof sourcesInputSchema>;

export const aiProviderInputSchema = z.strictObject({
  enabled: z.boolean(),
  /** Default model (models.yaml id); empty for codex-cli = the CLI's own default. Absent = unchanged. */
  model: text(200).optional(),
  /** Strong model (claude-cli, anthropic). Absent = unchanged. */
  strong_model: text(200).optional(),
});

export const aiInputSchema = z.strictObject({
  /** Global order of `claude-cli`, `codex-cli` and the `api` layer. Absent = unchanged. */
  order: z.array(z.enum(AI_PROVIDER_KINDS)).max(AI_PROVIDER_KINDS.length).optional(),
  providers: z.partialRecord(z.enum(AI_PROVIDER_IDS), aiProviderInputSchema),
});
export type AiInput = z.infer<typeof aiInputSchema>;

export const telegramInputSchema = z.strictObject({
  enabled: z.boolean(),
  /** Language of the Telegram messages (language.yaml `notify.locale`); null = the interface default. */
  notify_locale: z.enum(LOCALES).nullable().optional(),
});
export type TelegramInput = z.infer<typeof telegramInputSchema>;
