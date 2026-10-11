import { z } from "zod";

import { LOCALES } from "@/i18n/locale";
import { isLanguageCode } from "@/lib/i18n/languages";

/** An interface language: one of the messages files (`LOCALES`). */
export const uiLocaleSchema = z.enum(LOCALES, { error: `must be one of the interface languages: ${LOCALES.join(", ")}` });
/** Any language code `Intl` accepts (`en`, `de`, `pt-BR`): what the AI writes and what job ads are translated into. */
export const languageCodeSchema = z.string().trim().refine(isLanguageCode, { message: "must be a language code such as en, zh, de or pt-BR" });

/**
 * config/language.yaml: which language the interface, the AI texts, the translations, Telegram and the command line use.
 * The shipped default is English everywhere; an install from before the language settings gets its old behaviour (Chinese) written on upgrade.
 */
export const languageSchema = z.strictObject({
  ui: z.strictObject({
    /** The interface language of a browser that never picked one (the language menu stores a choice in a cookie). */
    default_locale: uiLocaleSchema,
  }),
  ai: z
    .strictObject({
      /** The language of every text the AI writes: fit reasons, gaps, the one-line summary, the job breakdown, suggestion reasons. */
      output: languageCodeSchema,
      /** The one-line summary is also written in these languages (so switching the interface language still shows one). */
      summary_also: z.array(languageCodeSchema).max(4).default([]),
    })
    .refine((ai) => new Set([ai.output, ...ai.summary_also]).size === 1 + ai.summary_also.length, { message: "must not repeat a language (output included)", path: ["summary_also"] }),
  translation: z.strictObject({
    /** Job ads are translated into this language; ads already in it are never translated. */
    target: languageCodeSchema,
  }),
  notify: z.strictObject({
    /** The language of Telegram messages; null = `ui.default_locale`. */
    locale: uiLocaleSchema.nullable().default(null),
  }),
  cli: z.strictObject({
    /** The language of `pnpm run doctor` and `pnpm sources:list`; null = `ui.default_locale`. `--lang` overrides it. */
    locale: uiLocaleSchema.nullable().default(null),
  }),
});

export type LanguageConfig = z.infer<typeof languageSchema>;
