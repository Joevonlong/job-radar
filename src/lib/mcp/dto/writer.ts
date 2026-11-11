/** Application writer outputs expose only the selected material and checked answer versions. */
import { z } from "zod";

import { descriptionDto } from "./jobs";
import { iso, linkDto, locationDto, notices } from "./shared";

const writerEvidenceDto = z.strictObject({
  source: z.string(),
  /** The story id of a `story` quote. */
  ref: z.string().nullable(),
  quote: z.string(),
  /** The check found this quote where it says it is, and it may back this kind of sentence. */
  valid: z.boolean(),
});

const writerSentenceDto = z.strictObject({
  text: z.string(),
  /** user | company | role | framing: what the sentence was checked as. */
  about: z.string(),
  /** supported | partial | unsupported | framing | web_unverified | user_written | ai_suggestion_unverified | external_unverified */
  status: z.string(),
  evidence: z.array(writerEvidenceDto),
  /** Figures and known names of the sentence that its valid evidence does not contain. */
  missing: z.array(z.string()),
  /** Words that look like names and were found nowhere they could rest on. */
  needs_check: z.array(z.string()),
});

export const writerVersionDto = z.strictObject({
  id: z.number().int(),
  /** draft | polish | coach_rewrite | manual | mcp */
  mode: z.string(),
  text: z.string(),
  is_final: z.boolean(),
  created_at: iso,
  sentences: z.array(writerSentenceDto),
});
export type WriterVersionDto = z.infer<typeof writerVersionDto>;

export const writerJdPointDto = z.strictObject({
  /** The breakdown's wording. Both this and `quote` are the trap marker when the quote overlaps a trap. */
  text: z.string(),
  quote: z.string(),
  /** must | nice; null when the breakdown does not say. */
  requirement: z.string().nullable(),
});

export const writerStoryDto = z.strictObject({
  /** The `ref` of a `story` quote. */
  id: z.string(),
  title: z.string(),
  what: z.string(),
  result: z.string().nullable(),
  metrics: z.array(z.string()),
  skills: z.array(z.string()),
  period: z.string().nullable(),
});

export const writerQuestionDto = z.strictObject({
  /** The `question_id` of save_application_answer. */
  id: z.number().int(),
  text: z.string(),
  /** question | letter */
  kind: z.string(),
  length: z.strictObject({ unit: z.string(), value: z.number().int() }),
  output_language: z.string(),
  tone: z.string(),
  /** What the user chose for this question; nothing else of theirs is in the result. */
  material: z.strictObject({
    jd_points: z.array(writerJdPointDto),
    /** The JD text itself is chosen as material (`job.description`). */
    use_jd_text: z.boolean(),
    profile: z.strictObject({ summary: z.string(), skills: z.array(z.string()), languages: z.array(z.string()) }).nullable(),
    stories: z.array(writerStoryDto),
    emphasis: z.string().nullable(),
    /** The fields of `company_background` chosen for this question; a `company` citation is checked against these only. */
    company_fields: z.array(z.string()),
  }),
  /** Newest first, at most mcp.yaml `limits.max_results`. */
  versions: z.array(writerVersionDto),
  versions_total: z.number().int(),
});
export type WriterQuestionDto = z.infer<typeof writerQuestionDto>;

export const getApplicationContextOutput = z.strictObject({
  notices,
  job: z.strictObject({
    id: z.number().int(),
    title: z.string(),
    company: z.string(),
    language: z.string(),
    locations: z.array(locationDto),
    links: z.array(linkDto),
    description: descriptionDto,
  }),
  /** Every point of the job's breakdown, chosen or not; empty without a breakdown or while the JD is withheld. */
  jd_points: z.array(writerJdPointDto),
  /** The newest AI web search of the company: unverified, quoted data. Null when there is none. */
  company_background: z
    .strictObject({
      expired: z.boolean(),
      fields: z.array(z.strictObject({ field: z.string(), text: z.string(), source_url: z.string().nullable() })),
    })
    .nullable(),
  /** The note joining that background with chosen stories. A `flagged` point failed the check of its quotes. Null when there is none. */
  fit_note: z
    .strictObject({
      outdated: z.boolean(),
      items: z.array(z.strictObject({ company_point: z.string(), your_point: z.string(), company_quote: z.string(), story_quote: z.string(), status: z.enum(["quotes_found", "flagged"]) })),
    })
    .nullable(),
  questions: z.array(writerQuestionDto),
});
export type GetApplicationContextOutput = z.infer<typeof getApplicationContextOutput>;

export const saveApplicationAnswerOutput = z.strictObject({
  notices,
  version_id: z.number().int(),
  question_id: z.number().int(),
  mode: z.literal("mcp"),
  /** How many sentences got each status. */
  sentences: z.record(z.string(), z.number().int()),
  /** The figures and names of the answer the check could not find in the evidence. */
  missing: z.array(z.string()),
  needs_check: z.array(z.string()),
});
export type SaveApplicationAnswerOutput = z.infer<typeof saveApplicationAnswerOutput>;
