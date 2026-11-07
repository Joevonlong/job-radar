import { z } from "zod";

import { outboundImportFields } from "./outbound-import";
import { figureUnitsSchema, firstPersonSchema, namesSchema } from "./writer";

export const CAREER_DEFAULT_TIMEOUT_SECONDS = 600;
export const CAREER_DEFAULT_EXPIRY_GRACE_SECONDS = 60;
export const CAREER_DEFAULT_QUEUE_TIMEOUT_SECONDS = 900;
export const CAREER_LANGS = ["en", "de"] as const;
export const CAREER_THEMES = ["minimal", "band", "classic", "compact", "split"] as const;
export const CAREER_PAPERS = ["a4", "letter"] as const;
export const CAREER_DENSITIES = ["compact", "normal", "relaxed"] as const;
export const careerAccentSchema = z.string().min(1).max(64).regex(/^[#a-zA-Z0-9(),.%\s/+-]+$/);

export const careerLayoutDefaultsSchema = z.strictObject({
  lang: z.enum(CAREER_LANGS).default("en"),
  theme: z.enum(CAREER_THEMES).default("classic"),
  accent: careerAccentSchema.default("#2f54eb"),
  pages: z.number().int().min(1).max(10).default(1),
  paper: z.enum(CAREER_PAPERS).default("a4"),
  density: z.enum(CAREER_DENSITIES).default("normal"),
});

const positive = (fallback: number, max: number) => z.number().int().min(1).max(max).default(fallback);

export const careerCheckLimitsSchema = z.strictObject({
  maxMentions: positive(4, 100000),
  goodCoverage: z.number().min(0).max(100).default(70),
  maxBullet: positive(200, 100000),
  minBullet: positive(40, 100000),
  maxBulletsPerEntry: positive(5, 100000),
  maxGapMonths: positive(6, 100000),
  proseMinWords: positive(12, 100000),
  proseClearWords: positive(20, 100000),
  proseRatio: positive(3, 100000),
  proseClearRatio: positive(4, 100000),
  maxRole: positive(200, 100000),
  letterPages: positive(1, 10),
  letterWords: z.strictObject({ min: positive(200, 100000), max: positive(450, 100000) }).prefault({}),
  minPiece: positive(16, 100000),
  maxPieces: positive(3, 100000),
});

const checkWords = z.array(z.string().min(1).max(1000)).max(10000).default([]);
const checkDictionary = z.record(z.string().min(1).max(200), checkWords).default({});

export const careerLanguageLexiconSchema = z.strictObject({
  keywords: checkDictionary,
  filler: checkWords,
  weak: checkWords,
  proseWords: checkWords,
  asksSalary: checkWords,
  asksStart: checkWords,
  stockOpener: checkWords,
  level: checkWords,
  titleStop: checkWords,
  legal: checkWords,
  letterLegal: checkWords,
  roleWord: checkWords,
  nice: checkWords,
  requiredHead: checkWords,
  skipHead: checkWords,
  tasksHead: checkWords,
  skipSentence: checkWords,
  notTech: checkWords,
  degree: z.strictObject({ words: checkWords, suffixes: checkWords }).prefault({}),
  langContext: checkWords,
  langs: checkDictionary,
  names: checkDictionary,
  levelWords: z.strictObject({
    native: checkWords,
    ranked: z.array(z.strictObject({ rank: z.number().int().min(1).max(6), words: checkWords })).max(6).default([]),
  }).prefault({}),
});

export const careerCheckLexiconSchema = z.strictObject({
  en: careerLanguageLexiconSchema.prefault({}),
  de: careerLanguageLexiconSchema.prefault({}),
});

export const careerSchema = z.strictObject({
  enabled: z.boolean().default(false),
  timeout_seconds: positive(CAREER_DEFAULT_TIMEOUT_SECONDS, 1800),
  expiry_grace_seconds: positive(CAREER_DEFAULT_EXPIRY_GRACE_SECONDS, 600),
  queue_timeout_seconds: positive(CAREER_DEFAULT_QUEUE_TIMEOUT_SECONDS, 7200),
  import: z
    .strictObject({
      formats: z
        .array(z.enum(["pdf", "md", "txt"]))
        .min(1)
        .max(3)
        .default(["pdf", "md", "txt"]),
      max_file_bytes: positive(2000000, 20000000),
      upload_timeout_seconds: positive(30, 300),
      max_chars: positive(30000, 200000),
      min_chars: positive(20, 200000),
      pdf_timeout_seconds: positive(15, 300),
      pdf_max_memory_mb: positive(256, 2048),
      max_concurrent_uploads: positive(2, 20),
      draft_ttl_days: positive(14, 365),
      max_pending_drafts: positive(5, 100),
      output_truncated_share: z.number().min(0).max(1).default(0.95),
      stored_value_min_chars: positive(3, 100),
      ...outboundImportFields,
    })
    .prefault({})
    .refine((value) => value.min_chars <= value.max_chars, { path: ["min_chars"], message: "invalid limits" }),
  profile: z
    .strictObject({
      max_entries: positive(100, 1000),
      max_bullets_per_entry: positive(30, 100),
      max_wordings_per_text: positive(10, 50),
      text_max_chars: positive(4000, 20000),
    })
    .prefault({}),
  history: z.strictObject({ keep_versions: positive(50, 1000) }).prefault({}),
  document: z.strictObject({
    max_documents: positive(100, 1000),
    image_max_bytes: positive(2000000, 20000000),
    max_request_bytes: positive(4000000, 50000000)
      .describe("Maximum preview request body in bytes. Document saves carry at most 1 MB, like profile saves."),
    defaults: careerLayoutDefaultsSchema.prefault({}),
  }).prefault({}),
  tailor: z.strictObject({
    max_requirements: positive(10, 100),
    requirement_max_chars: positive(500, 20000),
    duty_min_coverage: z.number().min(0).max(1).default(0.7),
    max_proposals: positive(100, 1000),
    jd_max_chars: positive(6000, 50000),
    jd_head_share: z.number().min(0.1).max(0.9).default(0.7),
    first_person: firstPersonSchema,
    names: namesSchema,
    stopwords: z.record(z.string().regex(/^[a-z]{2,3}$/), z.array(z.string().min(1).max(100)).max(1000)).default({ en: [], de: [] }),
  }).prefault({}),
  preview: z.strictObject({
    debounce_ms: z.number().int().min(50).max(10000).default(400),
    page_count_debounce_ms: positive(3000, 60000),
  }).prefault({}),
  check: z.strictObject({
    limits: careerCheckLimitsSchema.prefault({}),
    lexicon: careerCheckLexiconSchema.prefault({}),
    uncovered_max_chars: positive(32, 1000),
  }).prefault({}),
  pdf: z.strictObject({
    url: z.url({ protocol: /^https?$/ }).default("http://career-pdf:8090"),
    timeout_seconds: positive(60, 300),
    max_html_bytes: positive(8000000, 50000000),
  }).prefault({}),
  evidence: z
    .strictObject({
      min_quote_chars: positive(4, 1000),
      quote_max_chars: positive(160, 4000),
      figure_units: figureUnitsSchema.prefault({}),
    })
    .prefault({})
    .refine((value) => value.min_quote_chars <= value.quote_max_chars, {
      path: ["min_quote_chars"],
      message: "invalid limits",
    }),
});

export type CareerConfig = z.infer<typeof careerSchema>;
