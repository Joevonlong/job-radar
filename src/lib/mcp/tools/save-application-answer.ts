import { z } from "zod";

import { WRITE_LIMITS } from "@/lib/ai/prompts/write";
import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { appendAnswerVersion, getApplicationQuestion } from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { getCompanyResearchForJob } from "@/lib/db/repos/company-research";
import { splitSentences } from "@/lib/writer/diff";
import { materialsHash } from "@/lib/writer/hash";
import { jdPointsOf } from "@/lib/writer/jd-points";
import { parseSelection } from "@/lib/writer/selection";
import { buildSnapshot, questionSettingsOf } from "@/lib/writer/snapshot";
import { EVIDENCE_SOURCES, SENTENCE_ABOUT, type CheckedSentence } from "@/lib/writer/types";
import { countStatuses, joinSentences, normalize, verifySentences } from "@/lib/writer/verify";
import { writerVerifyContext } from "@/lib/writer/verify-context";

import { ToolFailure, type McpContext } from "../context";
import { saveApplicationAnswerOutput, type SaveApplicationAnswerOutput } from "../dto";
import { visibleText } from "../guard";
import { readTraps } from "./shared";
import { readWriterForTool } from "./writer-shared";

/** The most characters of one answer a call can carry (writer.yaml `draft_max_chars` is the limit that counts, up to this). */
const TEXT_CAP = 60_000;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function saveApplicationAnswerInput(ctx: Pick<McpContext, "text">) {
  const L = WRITE_LIMITS;
  return z.strictObject({
    job_id: id.describe(ctx.text("params.jobId")),
    question_id: id.describe(ctx.text("params.questionId")),
    text: z.string().trim().min(1).max(TEXT_CAP).describe(ctx.text("params.answerText")),
    sentences: z
      .array(
        z.strictObject({
          text: z.string().trim().min(1).max(L.sentenceChars),
          about: z.enum(SENTENCE_ABOUT),
          new_paragraph: z.boolean().optional(),
          evidence: z
            .array(z.strictObject({ source: z.enum(EVIDENCE_SOURCES), ref: z.string().trim().max(L.refChars).optional(), quote: z.string().trim().min(1).max(L.quoteChars) }))
            .max(L.evidence),
        }),
      )
      .min(1)
      .max(L.sentences)
      .optional()
      .describe(ctx.text("params.answerSentences")),
  });
}

export type SaveApplicationAnswerArgs = z.infer<ReturnType<typeof saveApplicationAnswerInput>>;

/**
 * Add one answer version of mode `mcp` to a question. That is all it can do: there is no argument for a status, a final answer, a
 * version to replace or anything to delete, and a question that is full refuses instead of dropping an older version
 * (`appendAnswerVersion`). What a client says about its sentences is a claim like any AI's: `sentences` are checked against the
 * material chosen for the question now and the stored JD, with the same check as the workbench, and `text` must be those
 * sentences, so an answer cannot carry the check result of another text. Without `sentences`, every sentence is
 * `external_unverified`. Invisible characters are removed first: the user copies this text out.
 */
export async function saveApplicationAnswer(ctx: McpContext, args: SaveApplicationAnswerArgs): Promise<SaveApplicationAnswerOutput> {
  const { writer, me, stories } = readWriterForTool(ctx);
  const writeDb = ctx.writer?.writeDb;
  if (!writeDb) throw new ToolFailure("disabled", ctx.text("errors.writerDisabled"));
  const notFound = (): ToolFailure => new ToolFailure("not_found", ctx.text("errors.questionNotFound", { id: args.question_id, job: args.job_id }));
  const [job, question] = await Promise.all([getJobForBreakdown(ctx.db, args.job_id), getApplicationQuestion(ctx.db, { jobId: args.job_id, questionId: args.question_id })]);
  if (!job || !question) throw notFound();

  const text = visibleText(args.text).trim();
  if (text === "" || text.length > writer.draft_max_chars) throw new ToolFailure("too_long", ctx.text("errors.answerLength", { max: writer.draft_max_chars }));

  const breakdown = await getJobBreakdown(ctx.db, args.job_id);
  const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
  const { materials } = buildSnapshot({
    question: questionSettingsOf(question),
    selection: parseSelection(question.selectedMaterials),
    job: { title: job.title, company: job.company },
    jdPoints: content ? jdPointsOf(content) : [],
    me,
    stories,
    writer,
    company: await getCompanyResearchForJob(ctx.db, args.job_id),
    traps: readTraps(ctx),
  });

  let sentences: CheckedSentence[];
  if (args.sentences) {
    const verify = writerVerifyContext({ jd: job.description ?? "", materials, techStack: content?.tech_stack.map((item) => item.name) ?? [], company: job.company, evidence: writer.evidence });
    sentences = verifySentences(
      args.sentences.map((sentence) => ({
        text: visibleText(sentence.text),
        about: sentence.about,
        newParagraph: sentence.new_paragraph ?? false,
        evidence: sentence.evidence.map((entry) => ({ source: entry.source, ref: entry.ref, quote: entry.quote })),
      })),
      verify,
    );
    if (normalize(joinSentences(sentences)) !== normalize(text)) throw new ToolFailure("text_mismatch", ctx.text("errors.answerMismatch"));
  } else {
    sentences = splitSentences(text).map((sentence) => ({ text: sentence.text, newParagraph: sentence.newParagraph, about: "user", status: "external_unverified", evidence: [], missing: [], needsCheck: [] }));
  }

  const counts = countStatuses(sentences);
  const { audit, auditCall } = ctx;
  const added = await appendAnswerVersion(writeDb, {
    onAdded: audit && auditCall ? async (tx) => { await audit.inTransaction(tx, auditCall.success(1)); } : undefined,
    jobId: args.job_id,
    questionId: args.question_id,
    maxVersions: writer.questions.max_versions_per_question,
    version: {
      mode: "mcp",
      text: joinSentences(sentences),
      sentences,
      supportedCount: counts.supported,
      partialCount: counts.partial,
      unsupportedCount: counts.unsupported,
      framingCount: counts.framing,
      userWrittenCount: counts.user_written,
      webUnverifiedCount: counts.web_unverified,
      materialsHash: materialsHash(materials),
    },
  });
  if (added.state === "not_found") throw notFound();
  if (added.state === "full") throw new ToolFailure("version_limit", ctx.text("errors.versionLimit", { max: writer.questions.max_versions_per_question }));
  if (ctx.audit && ctx.auditCall) ctx.auditCall.committed = true;

  const byStatus: Record<string, number> = {};
  for (const sentence of sentences) byStatus[sentence.status] = (byStatus[sentence.status] ?? 0) + 1;
  return saveApplicationAnswerOutput.parse({
    notices: [ctx.text("notice.savedUnchecked")],
    version_id: added.id,
    question_id: args.question_id,
    mode: "mcp",
    sentences: byStatus,
    missing: [...new Set(sentences.flatMap((sentence) => sentence.missing))],
    needs_check: [...new Set(sentences.flatMap((sentence) => sentence.needsCheck))],
  } satisfies SaveApplicationAnswerOutput);
}
