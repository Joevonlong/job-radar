/**
 * Shapes shared by the application writer's web side, the ai-worker handler and the stored versions. Plain types and
 * constants only (no zod, no server code), so client components can import them.
 */
import type { LengthUnit, QuestionKind } from "@/lib/config/schemas/writer";

/** What a sentence is about, as the AI labels it (a first-person sentence is checked as `user` whatever the label). */
export const SENTENCE_ABOUT = ["user", "company", "role", "framing"] as const;
export type SentenceAbout = (typeof SENTENCE_ABOUT)[number];

/** Where a piece of evidence comes from. `company` (the AI web search of the company) arrives with a later step. */
export const EVIDENCE_SOURCES = ["jd", "profile", "story", "emphasis", "draft", "company"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * A sentence's check result. `supported`: every fact rests on a quote found in your material (not a proof that it is true);
 * `partial`: evidence found, but a figure, technology or name of the sentence is not in it; `unsupported`: no valid
 * evidence; `framing`: a linking sentence without facts; `web_unverified`: rests only on the AI web search of the company;
 * `user_written`: you wrote or changed it; `ai_suggestion_unverified` / `external_unverified`: later writing modes.
 */
export const SENTENCE_STATUSES = ["supported", "partial", "unsupported", "framing", "web_unverified", "user_written", "ai_suggestion_unverified", "external_unverified"] as const;
export type SentenceStatus = (typeof SENTENCE_STATUSES)[number];

/** Why an evidence entry does not count. */
export type EvidenceProblem = "not_found" | "not_allowed" | "no_ref" | "unknown_ref";

export interface CheckedEvidence {
  source: EvidenceSource;
  ref?: string;
  quote: string;
  /** null: the entry counts for the sentence. */
  problem: EvidenceProblem | null;
}

export interface CheckedSentence {
  text: string;
  /** The sentence starts a new paragraph. */
  newParagraph: boolean;
  /** What the sentence was checked as (the AI's label, or `user` for a first-person sentence). */
  about: SentenceAbout;
  status: SentenceStatus;
  evidence: CheckedEvidence[];
  /** Figures and technology / company names of the sentence that its valid evidence does not contain. */
  missing: string[];
  /** Words that look like names (a former employer, a client, a person) found in neither the evidence nor the JD. */
  needsCheck: string[];
}

export type StatusCounts = Record<"supported" | "partial" | "unsupported" | "framing" | "user_written" | "web_unverified", number>;

/** The writing modes of a stored version. */
export const ANSWER_MODES = ["draft", "polish", "coach_rewrite", "manual", "mcp"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

/** A JD point chosen for a question: breakdown items have no id, so the choice is their JD quote and its place. */
export interface JdPointRef {
  quote: string;
  offset: number;
}

/** The material chosen for one question (stored on the question, `application_questions.selected_materials`). */
export interface QuestionSelection {
  jdPoints: JdPointRef[];
  /** Send an excerpt of the JD itself (no breakdown, or the user prefers it). */
  useJdText: boolean;
  storyIds: string[];
  /** Send the profile summary, skills and languages of me.yaml. */
  profile: boolean;
  emphasis: string;
}

export const EMPTY_SELECTION: QuestionSelection = { jdPoints: [], useJdText: false, storyIds: [], profile: true, emphasis: "" };

export interface QuestionSettings {
  text: string;
  kind: QuestionKind;
  lengthUnit: LengthUnit;
  lengthValue: number;
  outputLanguage: string;
  tone: string;
}

/** The parts of the AI input, in the order the disclosure lists them. */
export const WRITE_INPUT_FIELDS = ["question", "settings", "job", "jd_points", "jd_excerpt", "profile", "stories", "emphasis"] as const;
export type WriteInputField = (typeof WRITE_INPUT_FIELDS)[number];
