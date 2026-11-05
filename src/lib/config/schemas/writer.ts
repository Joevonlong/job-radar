import { z } from "zod";

import { nonEmptyString } from "./common";
import { STORY_FILE_BOUNDS } from "./stories";

/** How long one writing request may run, wait queued, and the expiry margin (also what an unreadable writer.yaml falls back to for the expiry). */
export const WRITER_DEFAULT_TIMEOUT_SECONDS = 180;
export const WRITER_DEFAULT_EXPIRY_GRACE_SECONDS = 60;
export const WRITER_DEFAULT_QUEUE_TIMEOUT_SECONDS = 900;

export const WRITER_STORIES_DEFAULTS = { max_items: 60, title_max_chars: 120, text_max_chars: 1500, preselect_count: 4 } as const;

/** The file types a résumé upload accepts (`import.formats`). */
export const STORY_IMPORT_FORMATS = ["pdf", "md", "txt"] as const;
export type StoryImportFormat = (typeof STORY_IMPORT_FORMATS)[number];

/** The two kinds of application question: a form question, or a cover letter (one long question). */
export const QUESTION_KINDS = ["question", "letter"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
/** How an answer's length is counted: words (space-separated languages) or characters (Chinese, Japanese). */
export const LENGTH_UNITS = ["words", "chars"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

const id = z.string().regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, "must be lowercase letters, digits, '-' or '_'").max(40);
const length = z.strictObject({ unit: z.enum(LENGTH_UNITS), value: z.number().int().min(10).max(5000) });
const kind = (unit: LengthUnit, value: number, variants: number) =>
  z.strictObject({ default_length: length, variants: z.number().int().min(1).max(5) }).default({ default_length: { unit, value }, variants });

const unique = <T extends z.ZodType<{ id: string }>>(item: T) =>
  z.array(item).min(1).max(10).refine((items) => new Set(items.map((entry) => entry.id)).size === items.length, "ids must be unique");

/** Words that make a sentence one about you (matched as whole words, case-insensitively). */
const wordList = z.array(nonEmptyString.max(40)).max(50);
/** For languages written without spaces (Chinese): matched as substrings, minus the `exclude` ones ("我们" is not "我"). */
const substringList = z.strictObject({ words: wordList, exclude: wordList.default([]) });

const NAME_RULES = ["single", "multi", "off"] as const;

/** The dimensions a coach review rates (a fresh array each time: zod defaults must not share one). */
function defaultCoachDimensions(): string[] {
  return ["answers_question", "concrete_evidence", "company_specific", "covers_must_haves", "length", "language_tone", "no_overclaim"];
}

/** The shipped first-person words (a fresh object each time: zod defaults must not share one). */
function defaultFirstPerson(): Record<string, string[] | { words: string[]; exclude: string[] }> {
  return {
    en: ["i", "i'm", "i've", "i'd", "my", "me", "myself"],
    de: ["ich", "mein", "meine", "meinen", "meinem", "meiner", "mich", "mir"],
    zh: { words: ["我", "我的"], exclude: ["我们", "我们的"] },
  };
}

/** The shipped question stopwords (a fresh list each time): words nearly every application question has, which say nothing about what it asks. */
function defaultQuestionStopwords(): string[] {
  return [
    ...["a", "an", "the", "is", "are", "was", "were", "be", "do", "does", "did", "have", "has", "what", "which", "how", "can", "could", "would", "will", "please", "tell", "describe", "you", "your", "i", "my", "me", "we", "our", "us", "of", "in", "on", "at", "to", "for", "with", "about", "and", "or", "this", "that"],
    ...["ein", "eine", "einen", "der", "die", "das", "ist", "sind", "was", "wie", "welche", "welcher", "welches", "sie", "ihre", "ihr", "ihren", "ihrer", "ich", "mein", "meine", "wir", "uns", "unser", "unsere", "bitte", "und", "oder", "bei", "zu", "für", "mit", "von", "in", "an", "auf"],
    ...["你", "您", "我", "们", "的", "是", "什", "么", "请", "吗", "呢", "了", "在", "和", "最", "大"],
  ];
}

/** The shipped figure units (a fresh object each time): magnitude words that follow a digit (5万, $2M, 3 Mio), and the ones that make it a multiple (40倍, 10x). */
export function defaultFigureUnits(): { scale: Record<string, number>; multiple: string[] } {
  return {
    scale: {
      ...{ 万: 10_000, 萬: 10_000, 亿: 100_000_000, 億: 100_000_000, 千: 1000 },
      ...{ thousand: 1000, tausend: 1000 },
      ...{ m: 1_000_000, mn: 1_000_000, mio: 1_000_000, million: 1_000_000, millionen: 1_000_000 },
      ...{ b: 1_000_000_000, bn: 1_000_000_000, mrd: 1_000_000_000, billion: 1_000_000_000, milliarden: 1_000_000_000 },
    },
    multiple: ["倍", "x"],
  };
}

/** Shared figure units used to check evidence in independent optional features. */
export const figureUnitsSchema = z.strictObject({
  scale: z.record(nonEmptyString.max(12), z.number().positive().max(1e12)).default(() => defaultFigureUnits().scale),
  multiple: z.array(nonEmptyString.max(12)).max(20).default(() => defaultFigureUnits().multiple),
});

/**
 * config/writer.yaml: the application writer and its experience library (`data/profile/stories.yaml`). Every key has a
 * default, so a missing file or section means "off" and the defaults below (a file written before a section existed keeps working).
 */
export const writerSchema = z.strictObject({
  /** Off by default: nothing of the writer is sent to an AI provider until this is true. */
  enabled: z.boolean().default(false),
  /**
   * Longest run of one writing request, from the moment the ai-worker took it: the worker stops the AI call then and the
   * request fails as `timeout`.
   */
  timeout_seconds: z.number().int().min(30).max(1800).default(WRITER_DEFAULT_TIMEOUT_SECONDS),
  /**
   * A running request still open `timeout_seconds` plus this long (its worker died or hangs) fails as `expired` and its
   * material is cleared. The margin lets the worker's own timeout decide first.
   */
  expiry_grace_seconds: z.number().int().min(10).max(600).default(WRITER_DEFAULT_EXPIRY_GRACE_SECONDS),
  /**
   * Longest wait of a queued request (one interactive request runs at a time, so a few pressed in a row wait for each
   * other); an older one fails as `expired` and its material is cleared.
   */
  queue_timeout_seconds: z.number().int().min(60).max(7200).default(WRITER_DEFAULT_QUEUE_TIMEOUT_SECONDS),
  /** Limits a save of the experience library must meet (the file format itself allows more). */
  stories: z
    .strictObject({
      /** Most stories in the library. */
      max_items: z.number().int().min(1).max(STORY_FILE_BOUNDS.items).default(WRITER_STORIES_DEFAULTS.max_items),
      /** Longest title; also the longest entry of a story's metrics, skills and tags. */
      title_max_chars: z.number().int().min(10).max(STORY_FILE_BOUNDS.listItemChars).default(WRITER_STORIES_DEFAULTS.title_max_chars),
      /** Longest "what you did" and "result" text. */
      text_max_chars: z.number().int().min(100).max(STORY_FILE_BOUNDS.textChars).default(WRITER_STORIES_DEFAULTS.text_max_chars),
      /** How many stories a new application question starts with selected (best skill overlap with the job first). */
      preselect_count: z.number().int().min(0).max(50).default(WRITER_STORIES_DEFAULTS.preselect_count),
    })
    .default(WRITER_STORIES_DEFAULTS),
  /** Extracting stories from your profile, a pasted text or an uploaded résumé. */
  import: z
    .strictObject({
      /** Largest résumé file, in bytes; a larger one is refused unread. */
      max_file_bytes: z.number().int().min(10_000).max(9_000_000).default(2_000_000),
      /** Longest source text sent to the AI, in characters; a longer one is cut and the page says so. */
      max_chars: z.number().int().min(1000).max(200_000).default(30_000),
      /** A source with less text than this has nothing to extract (a scanned PDF has no text layer). */
      min_chars: z.number().int().min(1).max(1000).default(20),
      /** File types a résumé may have. */
      formats: z
        .array(z.enum(STORY_IMPORT_FORMATS))
        .min(1)
        .refine((items) => new Set(items).size === items.length, "must not contain duplicates")
        .default(["pdf", "md", "txt"]),
      /** Most drafts one extraction may return. */
      max_drafts: z.number().int().min(1).max(50).default(12),
      /** Longest a PDF may take to read; a crafted file can keep the parser busy with few bytes. */
      pdf_timeout_seconds: z.number().positive().max(120).default(15),
      /** Heap limit of the PDF reading thread, in MB. Memory outside the JavaScript heap (buffers) is not counted, so this does not cap the process; the time limit is what stops a crafted file. */
      pdf_max_memory_mb: z.number().int().min(32).max(2048).default(256),
      /** Longest the upload's body may take to arrive; a slower sender is cut off. */
      upload_timeout_seconds: z.number().positive().max(300).default(30),
      /** Most résumé files read at the same time by one web process; another is refused until one ends (each holds its file in memory and may start a PDF thread). */
      max_concurrent_uploads: z.number().int().min(1).max(10).default(2),
      /** Days a draft waits for review; older ones are deleted, reviewed or not. */
      draft_ttl_days: z.number().int().min(1).max(365).default(14),
    })
    .prefault({}),
  questions: z
    .strictObject({
      /** Most questions per job. */
      max_per_job: z.number().int().min(1).max(50).default(12),
      /** Longest question text. */
      text_max_chars: z.number().int().min(50).max(10_000).default(1000),
      /** Most versions of one question that are not the final one; the oldest is removed beyond it. */
      max_versions_per_question: z.number().int().min(2).max(200).default(20),
      /** Default length and number of versions per question kind. */
      kinds: z
        .strictObject({ question: kind("words", 150, 3), letter: kind("words", 350, 2) })
        .prefault({}),
    })
    .prefault({}),
  /** The styles of the versions one draft asks for, in order (a request asks for the first `variants` of them). */
  variants: unique(z.strictObject({ id, hint: nonEmptyString.max(200) })).default([
    { id: "safe", hint: "clear and conservative" },
    { id: "distinctive", hint: "more personal voice" },
    { id: "short", hint: "tighter, about 70% of the target length" },
  ]),
  /** The tones a question may ask for (the first is the default). */
  tones: z
    .array(id)
    .min(1)
    .max(10)
    .refine((items) => new Set(items).size === items.length, "must not contain duplicates")
    .default(["neutral", "warm", "confident", "formal"]),
  /** Longest "what to emphasise this time" note. */
  emphasis_max_chars: z.number().int().min(50).max(5000).default(800),
  /** Longest text of your own that can be polished (and the longest answer that can be reviewed). */
  draft_max_chars: z.number().int().min(200).max(50_000).default(6000),
  /** The coach review (an AI reading of an answer; its score is a judgement, not a measurement). */
  coach: z
    .strictObject({
      /** What the review rates, one entry each (ids; the shipped ones have an explanation in the prompt). */
      dimensions: z
        .array(id)
        .min(1)
        .max(15)
        .refine((items) => new Set(items).size === items.length, "must not contain duplicates")
        .default(defaultCoachDimensions),
      /** Most sentence suggestions one review returns. */
      max_suggestions: z.number().int().min(1).max(20).default(8),
    })
    .prefault({}),
  /** Longest JD excerpt sent when no breakdown points are selected (like breakdown.yaml's `jd_max_chars`). */
  jd_max_chars: z.number().int().min(500).max(50_000).default(6000),
  /** Share of `jd_max_chars` taken from the beginning when the JD is cut (the rest from its end, like breakdown.yaml's `jd_head_share`). */
  jd_head_share: z.number().min(0.1).max(0.9).default(0.7),
  /** A call whose output reached this share of the output token cap and did not parse was cut off (`output_truncated`), not malformed. */
  output_truncated_share: z.number().min(0.5).max(1).default(0.95),
  /** The note on what the company background means for an application. */
  fit: z.strictObject({ /** Most points in one note. */ max_items: z.number().int().min(1).max(20).default(5) }).prefault({}),
  /** Offering a finalised answer to a similar question of another job as the starting text (local, no AI call). */
  reuse: z
    .strictObject({
      /** Lowest word overlap (0..1, Jaccard) between a new question and an earlier one for the earlier answer to be offered. */
      min_similarity: z.number().min(0.05).max(1).default(0.55),
      /** Most earlier answers offered for one new question (the most similar first). */
      max_candidates: z.number().int().min(1).max(10).default(3),
      /** Fewest words a new question needs before earlier answers are looked up (every Chinese, Japanese or Korean character counts as a word). */
      min_question_words: z.number().int().min(1).max(50).default(3),
      /** Words left out when two questions are compared, because nearly every question has them ("what is your greatest ..."). */
      stopwords: z.array(nonEmptyString.max(40)).max(500).default(defaultQuestionStopwords),
    })
    .prefault({}),
  /** The sentence-by-sentence evidence check (deterministic, no AI call). */
  evidence: z
    .strictObject({
      /** Longest quote the AI may give as evidence (keeps the output short). */
      quote_max_chars: z.number().int().min(20).max(1000).default(160),
      /** Shortest quote that counts as evidence (characters); a shorter one counts only when it is a known name such as a skill ("Go"). */
      min_quote_chars: z.number().int().min(1).max(50).default(4),
      /** Per language: words that make a sentence one about you, whatever the AI labelled it. */
      first_person: z.record(z.string().regex(/^[a-z]{2,3}$/), z.union([wordList, substringList])).default(defaultFirstPerson),
      /**
       * Words written right after a digit that change what the figure means: `scale` multiplies it (5万 is 50,000, so it
       * matches 50,000 and not 5), `multiple` makes it a multiple (40倍), which matches only a multiple, never 40 or 40%.
       */
      figure_units: figureUnitsSchema.prefault({}),
      /** Which words count as names to check (language-independent; a name not found in the sentence's valid quotes is flagged; a sentence about the job or company may also find it in the JD or company background). */
      names: z
        .strictObject({
          /** Names in quotation marks ("…", “…”, „…“, «…», 「…」). */
          quoted: z.boolean().default(true),
          /** Words with digits, inner capitals or all capitals (S3, GitLab, AWS). */
          mixed_tokens: z.boolean().default(true),
          /**
           * Capitalised words not at the start of a sentence: `single` = each one, `multi` = only two or more in a row (for
           * languages that capitalise every noun, such as German), `off` = none. `default` applies to every other language.
           */
          capitalized_non_initial: z.record(z.string().regex(/^([a-z]{2,3}|default)$/), z.enum(NAME_RULES)).default({ default: "single", de: "multi" }),
          /** Capitalised words that are never names. */
          stopwords: z.array(nonEmptyString.max(40)).max(200).default(["I", "OK"]),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type WriterConfig = z.infer<typeof writerSchema>;
export type WriterStoriesLimits = WriterConfig["stories"];
export type WriterEvidenceConfig = WriterConfig["evidence"];
