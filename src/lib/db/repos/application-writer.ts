/**
 * The application writer's questions and answer versions (C9: all access to `application_questions` and
 * `application_answer_versions` lives here). Every write names the job (or question) it is for, so an id alone never
 * reaches another job's rows.
 */
import { and, asc, count, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { applicationAnswerVersions, applicationQuestions, companies, jobs } from "../schema";

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
 * Store new versions of a question and drop its oldest versions beyond `maxVersions` (the final one is kept on top and not
 * counted), in one transaction. A version of a request that was already stored (`control_request_id` + `variant_id`) is
 * skipped, so a request run again never doubles its versions. Returns the ids stored now; nothing when the question is gone.
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
      .where(
        and(
          eq(applicationAnswerVersions.questionId, input.questionId),
          question.finalVersionId === null ? undefined : ne(applicationAnswerVersions.id, question.finalVersionId),
        ),
      )
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

/** A finalised answer of another job, as far as ranking needs it: the question's text and where the answer stands. */
export interface ReusableAnswer {
  versionId: number;
  questionId: number;
  jobId: number;
  jobTitle: string;
  company: string;
  /** The question's text. */
  text: string;
}

/**
 * The questions of every job but `excludeJobId` that have a final answer, newest answer first. Only the question text and
 * names are read (the answer itself comes with `getReusableAnswerText`), so ranking many of them stays cheap.
 */
export async function listReusableAnswers(db: Executor, input: { excludeJobId: number }): Promise<ReusableAnswer[]> {
  return db
    .select({
      versionId: applicationAnswerVersions.id,
      questionId: applicationQuestions.id,
      jobId: applicationQuestions.jobId,
      jobTitle: jobs.title,
      company: companies.name,
      text: applicationQuestions.text,
    })
    .from(applicationQuestions)
    .innerJoin(applicationAnswerVersions, and(eq(applicationAnswerVersions.id, applicationQuestions.finalVersionId), eq(applicationAnswerVersions.questionId, applicationQuestions.id)))
    .innerJoin(jobs, eq(jobs.id, applicationQuestions.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(ne(applicationQuestions.jobId, input.excludeJobId))
    .orderBy(desc(applicationAnswerVersions.createdAt), desc(applicationAnswerVersions.id));
}

/** The text of a version that is the final answer of a question of another job than `excludeJobId`; null for any other version. */
export async function getReusableAnswerText(db: Executor, input: { versionId: number; excludeJobId: number }): Promise<{ text: string; company: string; jobTitle: string } | null> {
  const [row] = await db
    .select({ text: applicationAnswerVersions.text, company: companies.name, jobTitle: jobs.title })
    .from(applicationAnswerVersions)
    .innerJoin(applicationQuestions, and(eq(applicationQuestions.id, applicationAnswerVersions.questionId), eq(applicationQuestions.finalVersionId, applicationAnswerVersions.id)))
    .innerJoin(jobs, eq(jobs.id, applicationQuestions.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(eq(applicationAnswerVersions.id, input.versionId), ne(applicationQuestions.jobId, input.excludeJobId)))
    .limit(1);
  return row ?? null;
}

/** Which job and company each of these versions belongs to (a version that no longer exists is missing from the result). */
export async function listVersionOrigins(db: Executor, versionIds: readonly number[]): Promise<Map<number, { jobId: number; jobTitle: string; company: string }>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db
    .select({ versionId: applicationAnswerVersions.id, jobId: applicationQuestions.jobId, jobTitle: jobs.title, company: companies.name })
    .from(applicationAnswerVersions)
    .innerJoin(applicationQuestions, eq(applicationQuestions.id, applicationAnswerVersions.questionId))
    .innerJoin(jobs, eq(jobs.id, applicationQuestions.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(applicationAnswerVersions.id, [...versionIds]));
  return new Map(rows.map((row) => [row.versionId, { jobId: row.jobId, jobTitle: row.jobTitle, company: row.company }]));
}
