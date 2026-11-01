/**
 * The application writer's questions and answer versions (C9: all access to `application_questions` and
 * `application_answer_versions` lives here). Every write names the job (or question) it is for, so an id alone never
 * reaches another job's rows.
 */
import { and, asc, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { applicationAnswerVersions, applicationQuestions } from "../schema";

export type ApplicationQuestionRow = typeof applicationQuestions.$inferSelect;
export type AnswerVersionRow = typeof applicationAnswerVersions.$inferSelect;

export interface QuestionFields {
  text: string;
  kind: string;
  lengthUnit: string;
  lengthValue: number;
  outputLanguage: string;
  tone: string;
  selectedMaterials: unknown;
  finalVersionId: number | null;
}

export async function listApplicationQuestions(db: Executor, jobId: number): Promise<ApplicationQuestionRow[]> {
  return db.select().from(applicationQuestions).where(eq(applicationQuestions.jobId, jobId)).orderBy(asc(applicationQuestions.position), asc(applicationQuestions.id));
}

export async function getApplicationQuestion(db: Executor, input: { jobId: number; questionId: number }): Promise<ApplicationQuestionRow | null> {
  const [row] = await db
    .select()
    .from(applicationQuestions)
    .where(and(eq(applicationQuestions.id, input.questionId), eq(applicationQuestions.jobId, input.jobId)))
    .limit(1);
  return row ?? null;
}

/** Add a question at the end of the job's list; null when the job already has `maxPerJob` questions. */
export async function createApplicationQuestion(
  db: Executor,
  input: { maxPerJob: number; fields: Omit<QuestionFields, "finalVersionId"> & { jobId: number } },
): Promise<ApplicationQuestionRow | null> {
  const { maxPerJob, fields } = input;
  return db.transaction(async (tx) => {
    // serialise concurrent adds of one job, so the limit holds
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('application_questions'), ${fields.jobId}::int)`);
    const [stats] = await tx
      .select({ total: count(), last: sql<number | null>`max(${applicationQuestions.position})` })
      .from(applicationQuestions)
      .where(eq(applicationQuestions.jobId, fields.jobId));
    if ((stats?.total ?? 0) >= maxPerJob) return null;
    const [row] = await tx
      .insert(applicationQuestions)
      .values({ ...fields, position: (stats?.last ?? -1) + 1 })
      .returning();
    return row ?? null;
  });
}

/** Change a question's text, settings or selection; false when it is not this job's. */
export async function updateApplicationQuestion(db: Executor, input: { jobId: number; questionId: number; fields: Partial<QuestionFields> }): Promise<boolean> {
  const rows = await db
    .update(applicationQuestions)
    .set({ ...input.fields, updatedAt: new Date() })
    .where(and(eq(applicationQuestions.id, input.questionId), eq(applicationQuestions.jobId, input.jobId)))
    .returning({ id: applicationQuestions.id });
  return rows.length > 0;
}

/** Delete a question and its versions (cascade). */
export async function deleteApplicationQuestion(db: Executor, input: { jobId: number; questionId: number }): Promise<boolean> {
  const rows = await db
    .delete(applicationQuestions)
    .where(and(eq(applicationQuestions.id, input.questionId), eq(applicationQuestions.jobId, input.jobId)))
    .returning({ id: applicationQuestions.id });
  return rows.length > 0;
}

/** The versions of these questions, newest first. */
export async function listAnswerVersions(db: Executor, questionIds: readonly number[]): Promise<AnswerVersionRow[]> {
  if (questionIds.length === 0) return [];
  return db
    .select()
    .from(applicationAnswerVersions)
    .where(inArray(applicationAnswerVersions.questionId, [...questionIds]))
    .orderBy(desc(applicationAnswerVersions.createdAt), desc(applicationAnswerVersions.id));
}

export async function getAnswerVersion(db: Executor, input: { questionId: number; versionId: number }): Promise<AnswerVersionRow | null> {
  const [row] = await db
    .select()
    .from(applicationAnswerVersions)
    .where(and(eq(applicationAnswerVersions.id, input.versionId), eq(applicationAnswerVersions.questionId, input.questionId)))
    .limit(1);
  return row ?? null;
}

export type AnswerVersionInput = Omit<typeof applicationAnswerVersions.$inferInsert, "id" | "questionId" | "createdAt">;

/**
 * Store new versions of a question and drop its oldest versions beyond `maxVersions` (the final one is always kept), in
 * one transaction. A version of a request that was already stored (`control_request_id` + `variant_id`) is skipped, so a
 * request run again never doubles its versions. Returns the ids stored now; nothing when the question is gone.
 */
export async function insertAnswerVersions(db: Executor, input: { questionId: number; versions: readonly AnswerVersionInput[]; maxVersions: number }): Promise<number[]> {
  if (input.versions.length === 0) return [];
  return db.transaction(async (tx) => {
    const [question] = await tx
      .select({ id: applicationQuestions.id, finalVersionId: applicationQuestions.finalVersionId })
      .from(applicationQuestions)
      .where(eq(applicationQuestions.id, input.questionId))
      .for("update");
    if (!question) return [];
    const inserted = await tx
      .insert(applicationAnswerVersions)
      .values(input.versions.map((version) => ({ ...version, questionId: input.questionId })))
      .onConflictDoNothing()
      .returning({ id: applicationAnswerVersions.id });
    const keep = await tx
      .select({ id: applicationAnswerVersions.id })
      .from(applicationAnswerVersions)
      .where(eq(applicationAnswerVersions.questionId, input.questionId))
      .orderBy(desc(applicationAnswerVersions.createdAt), desc(applicationAnswerVersions.id))
      .limit(Math.max(1, input.maxVersions));
    const kept = keep.map((row) => row.id);
    if (question.finalVersionId !== null) kept.push(question.finalVersionId);
    await tx
      .delete(applicationAnswerVersions)
      .where(and(eq(applicationAnswerVersions.questionId, input.questionId), notInArray(applicationAnswerVersions.id, kept)));
    return inserted.map((row) => row.id).filter((id) => kept.includes(id));
  });
}

/** Mark a version as the question's final answer (null: none); false when the question or version is not this job's. */
export async function setFinalAnswerVersion(db: Executor, input: { jobId: number; questionId: number; versionId: number | null }): Promise<boolean> {
  if (input.versionId !== null && !(await getAnswerVersion(db, { questionId: input.questionId, versionId: input.versionId }))) return false;
  return updateApplicationQuestion(db, { jobId: input.jobId, questionId: input.questionId, fields: { finalVersionId: input.versionId } });
}

/** How many questions the job has and how many of them have a final answer (the entry button on the job page). */
export async function countApplicationAnswers(db: Executor, jobId: number): Promise<{ questions: number; final: number }> {
  const [row] = await db
    .select({ questions: count(), final: sql<number>`count(${applicationQuestions.finalVersionId})::int` })
    .from(applicationQuestions)
    .where(eq(applicationQuestions.jobId, jobId));
  return { questions: row?.questions ?? 0, final: row?.final ?? 0 };
}
