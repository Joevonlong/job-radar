/** Everything the workbench page (`/jobs/<id>/apply`) shows, read in one place. Server only. */
import { aiDisclosure } from "@/lib/ai/disclosure";
import type { AiProviderId } from "@/lib/ai/types";
import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { ConfigError, reloadConfig, writerSchema } from "@/lib/config";
import type { LengthUnit, QuestionKind } from "@/lib/config/schemas/writer";
import { readInitialWriterRequests, type InitialWriterRequest } from "@/lib/control/writer-request";
import type { Db } from "@/lib/db/client";
import { listAnswerVersions, listApplicationQuestions } from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { getJob } from "@/lib/db/repos/jobs";
import { aiOutputLanguage } from "@/lib/i18n/config";
import { isLanguageCode } from "@/lib/i18n/languages";
import { descriptionHash } from "@/lib/translation/hash";

import { jdPointsOf, resolveJdPoints, type JdPoint } from "./jd-points";
import { parseSelection } from "./selection";
import { readWriterInputs } from "./settings";
import { parseStoredSentences } from "./stored";
import type { AnswerMode, CheckedSentence, QuestionSelection, StatusCounts } from "./types";

export interface WorkbenchVersion {
  id: number;
  mode: AnswerMode;
  variantId: string | null;
  text: string;
  sentences: CheckedSentence[];
  counts: StatusCounts;
  /** ISO time. */
  createdAt: string;
  provider: string | null;
  model: string | null;
}

export interface WorkbenchQuestion {
  id: number;
  text: string;
  kind: QuestionKind;
  lengthUnit: LengthUnit;
  lengthValue: number;
  outputLanguage: string;
  tone: string;
  selection: QuestionSelection;
  finalVersionId: number | null;
  /** Newest first. */
  versions: WorkbenchVersion[];
  initialRequest: InitialWriterRequest | null;
  /** Chosen JD points / stories that no longer exist. */
  stale: { jdPoints: number; stories: number };
}

export type WriterAvailability = "enabled" | "disabled" | "config_error";

export interface WorkbenchView {
  job: { id: number; title: string; company: string; hasDescription: boolean };
  availability: WriterAvailability;
  /** `outdated`: the breakdown was made from an older JD (or an older prompt); its points are still offered. */
  breakdown: "none" | "outdated" | "current";
  jdPoints: JdPoint[];
  stories: { id: string; title: string; skills: string[]; period: string | null }[];
  /** stories.yaml cannot be read: the stories group says so (and no chosen story counts as stale). */
  storiesUnreadable: boolean;
  /** me.yaml could be read (the profile can be sent). */
  profile: { available: boolean; summary: string; skills: string[] };
  questions: WorkbenchQuestion[];
  limits: { maxQuestions: number; textMaxChars: number; emphasisMaxChars: number };
  tones: string[];
  kinds: Record<QuestionKind, { unit: LengthUnit; value: number; variants: number }>;
  /** A new question's answer language: the JD's language when known, else language.yaml's AI output language. */
  defaultLanguage: string;
  languages: string[];
  /** The providers the `write` task may go to, in order (the disclosure bar). */
  providers: AiProviderId[];
}

function writeProviders(): AiProviderId[] {
  try {
    return aiDisclosure(reloadConfig("ai")).find((row) => row.task === "write")?.providers ?? [];
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
}

export async function loadWorkbench(db: Db, jobId: number): Promise<WorkbenchView | null> {
  const [job, named, breakdownRow, questionRows] = await Promise.all([getJob(db, jobId), getJobForBreakdown(db, jobId), getJobBreakdown(db, jobId), listApplicationQuestions(db, jobId)]);
  if (!job || !named) return null;
  const inputs = readWriterInputs();
  // the defaults when writer.yaml cannot be read (the page then shows the config error and writes nothing)
  const writer = inputs.writer ?? writerSchema.parse({});
  const availability: WriterAvailability = inputs.writer === null ? "config_error" : inputs.writer.enabled ? "enabled" : "disabled";

  const content = breakdownRow ? parseStoredBreakdown(breakdownRow.promptVersion, breakdownRow.content) : null;
  const jdPoints = content ? jdPointsOf(content) : [];
  const current = breakdownRow !== null && content !== null && job.description !== null && breakdownRow.sourceHash === descriptionHash(job.description);
  const breakdown = breakdownRow === null ? "none" : current ? "current" : "outdated";

  const versionRows = await listAnswerVersions(db, questionRows.map((row) => row.id));
  const newestVersionAt = new Map<number, Date>();
  for (const row of versionRows) if (!newestVersionAt.has(row.questionId)) newestVersionAt.set(row.questionId, row.createdAt);
  const requests = await readInitialWriterRequests(db, jobId, newestVersionAt);
  const storyIds = new Set(inputs.stories.map((story) => story.id));

  const questions: WorkbenchQuestion[] = questionRows.map((row) => {
    const stored = parseSelection(row.selectedMaterials);
    const resolved = resolveJdPoints(jdPoints, stored.jdPoints);
    const selection = { ...stored, jdPoints: resolved.refs };
    return {
      id: row.id,
      text: row.text,
      kind: row.kind === "letter" ? "letter" : "question",
      lengthUnit: row.lengthUnit === "chars" ? "chars" : "words",
      lengthValue: row.lengthValue,
      outputLanguage: row.outputLanguage,
      tone: row.tone,
      selection,
      finalVersionId: row.finalVersionId,
      versions: versionRows
        .filter((version) => version.questionId === row.id)
        .map((version) => ({
          id: version.id,
          mode: version.mode as AnswerMode,
          variantId: version.variantId,
          text: version.text,
          sentences: parseStoredSentences(version.sentences, version.text),
          counts: {
            supported: version.supportedCount,
            partial: version.partialCount,
            unsupported: version.unsupportedCount,
            framing: version.framingCount,
            user_written: version.userWrittenCount,
            web_unverified: version.webUnverifiedCount,
          },
          createdAt: version.createdAt.toISOString(),
          provider: version.provider,
          model: version.model,
        })),
      initialRequest: requests.get(row.id) ?? null,
      stale: { jdPoints: resolved.stale, stories: inputs.storiesUnreadable ? 0 : selection.storyIds.filter((id) => !storyIds.has(id)).length },
    };
  });

  const aiLanguage = aiOutputLanguage();
  const jobLanguage = job.language !== null && job.language !== "unknown" && isLanguageCode(job.language) ? job.language : null;
  const defaultLanguage = jobLanguage ?? aiLanguage;
  return {
    job: { id: job.id, title: job.title, company: named.company, hasDescription: job.description !== null && job.description.trim() !== "" },
    availability,
    breakdown,
    jdPoints,
    stories: inputs.stories.map((story) => ({ id: story.id, title: story.title, skills: story.skills, period: story.period ?? null })),
    storiesUnreadable: inputs.storiesUnreadable,
    profile: { available: inputs.me !== null, summary: inputs.me?.summary ?? "", skills: inputs.me?.skills.map((skill) => skill.name) ?? [] },
    questions,
    limits: { maxQuestions: writer.questions.max_per_job, textMaxChars: writer.questions.text_max_chars, emphasisMaxChars: writer.emphasis_max_chars },
    tones: writer.tones,
    kinds: {
      question: { unit: writer.questions.kinds.question.default_length.unit, value: writer.questions.kinds.question.default_length.value, variants: writer.questions.kinds.question.variants },
      letter: { unit: writer.questions.kinds.letter.default_length.unit, value: writer.questions.kinds.letter.default_length.value, variants: writer.questions.kinds.letter.variants },
    },
    defaultLanguage,
    languages: [...new Set([defaultLanguage, aiLanguage, "en", "de", "zh", ...questions.map((question) => question.outputLanguage)])],
    providers: writeProviders(),
  };
}
