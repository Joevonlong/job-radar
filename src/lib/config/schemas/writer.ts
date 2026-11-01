import { z } from "zod";

import { nonEmptyString } from "./common";
import { STORY_FILE_BOUNDS } from "./stories";

/** How long one writing request may run, wait queued, and the expiry margin (also what an unreadable writer.yaml falls back to for the expiry). */
export const WRITER_DEFAULT_TIMEOUT_SECONDS = 180;
export const WRITER_DEFAULT_EXPIRY_GRACE_SECONDS = 60;
export const WRITER_DEFAULT_QUEUE_TIMEOUT_SECONDS = 900;

export const WRITER_STORIES_DEFAULTS = { max_items: 60, title_max_chars: 120, text_max_chars: 1500, preselect_count: 4 } as const;

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

/** The shipped first-person words (a fresh object each time: zod defaults must not share one). */
function defaultFirstPerson(): Record<string, string[] | { words: string[]; exclude: string[] }> {
  return {
    en: ["i", "i'm", "i've", "i'd", "my", "me", "myself"],
    de: ["ich", "mein", "meine", "meinen", "meinem", "meiner", "mich", "mir"],
    zh: { words: ["我", "我的"], exclude: ["我们", "我们的"] },
  };
}

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
  /** Longest JD excerpt sent when no breakdown points are selected (like breakdown.yaml's `jd_max_chars`). */
  jd_max_chars: z.number().int().min(500).max(50_000).default(6000),
  /** Share of `jd_max_chars` taken from the beginning when the JD is cut (the rest from its end, like breakdown.yaml's `jd_head_share`). */
  jd_head_share: z.number().min(0.1).max(0.9).default(0.7),
  /** A call whose output reached this share of the output token cap and did not parse was cut off (`output_truncated`), not malformed. */
  output_truncated_share: z.number().min(0.5).max(1).default(0.95),
  /** Offering a finalised answer to a similar question of another job as the starting text (local, no AI call). */
  reuse: z
    .strictObject({
      /** Lowest word overlap (0..1, Jaccard) between a new question and an earlier one for the earlier answer to be offered. */
      min_similarity: z.number().min(0.05).max(1).default(0.55),
      /** Most earlier answers offered for one new question (the most similar first). */
      max_candidates: z.number().int().min(1).max(10).default(3),
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
