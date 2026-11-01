import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  createApplicationQuestion,
  getReusableAnswerText,
  insertAnswerVersions,
  listReusableAnswers,
  listVersionOrigins,
  setFinalAnswerVersion,
} from "@/lib/db/repos/application-writer";

const url = inject("testDatabaseUrl");
const db = () => getDb();

async function addJob(company: string, title: string): Promise<number> {
  const [row] = await db().insert(schema.companies).values({ name: company, nameNorm: company.toLowerCase() }).returning();
  const [job] = await db().insert(schema.jobs).values({ companyId: row!.id, title, titleNorm: title.toLowerCase(), description: "d", language: "en" }).returning();
  return job!.id;
}

/** A question of the job with one version; `final` marks it as the question's final answer. */
async function answer(jobId: number, input: { question: string; text: string; final: boolean; parentVersionId?: number }) {
  const question = await createApplicationQuestion(db(), {
    maxPerJob: 12,
    fields: { jobId, text: input.question, kind: "question", lengthUnit: "words", lengthValue: 150, outputLanguage: "en", tone: "neutral", selectedMaterials: {} },
  });
  const [versionId] = await insertAnswerVersions(db(), {
    questionId: question!.id,
    maxVersions: 20,
    versions: [{ mode: "manual", text: input.text, sentences: [], ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }) }],
  });
  if (input.final) await setFinalAnswerVersion(db(), { jobId, questionId: question!.id, versionId: versionId! });
  return { questionId: question!.id, versionId: versionId! };
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await db().execute(sql`truncate table jobs, companies restart identity cascade`);
});
afterAll(async () => {
  await db().execute(sql`truncate table jobs, companies restart identity cascade`);
  await closeDb();
});

describe("reusing a final answer", () => {
  it("lists the final answers of the other jobs only, newest first, with the names but not the answer text", async () => {
    const here = await addJob("Globex", "Platform Engineer");
    const acme = await addJob("Acme", "Backend Engineer");
    const initech = await addJob("Initech", "SRE");
    await answer(here, { question: "Why us (own job)?", text: "own", final: true });
    const older = await answer(acme, { question: "Why do you want to join Acme?", text: "Acme answer", final: true });
    await answer(acme, { question: "A draft that was never finalised", text: "draft", final: false });
    const newer = await answer(initech, { question: "Why do you want to join Initech?", text: "Initech answer", final: true });

    const rows = await listReusableAnswers(db(), { excludeJobId: here });
    expect(rows.map((row) => ({ versionId: row.versionId, company: row.company, jobTitle: row.jobTitle, text: row.text }))).toEqual([
      { versionId: newer.versionId, company: "Initech", jobTitle: "SRE", text: "Why do you want to join Initech?" },
      { versionId: older.versionId, company: "Acme", jobTitle: "Backend Engineer", text: "Why do you want to join Acme?" },
    ]);
    expect(rows[0]).not.toHaveProperty("answer");
    expect(JSON.stringify(rows)).not.toContain("Initech answer");
  });

  it("a version that is no longer the final one is not offered", async () => {
    const here = await addJob("Globex", "Platform Engineer");
    const acme = await addJob("Acme", "Backend Engineer");
    const first = await answer(acme, { question: "Why us?", text: "first", final: true });
    const [second] = await insertAnswerVersions(db(), { questionId: first.questionId, maxVersions: 20, versions: [{ mode: "manual", text: "second", sentences: [] }] });
    await setFinalAnswerVersion(db(), { jobId: acme, questionId: first.questionId, versionId: second! });
    expect((await listReusableAnswers(db(), { excludeJobId: here })).map((row) => row.versionId)).toEqual([second]);
    expect(await getReusableAnswerText(db(), { versionId: first.versionId, excludeJobId: here })).toBeNull();
    expect(await getReusableAnswerText(db(), { versionId: second!, excludeJobId: here })).toEqual({ text: "second", company: "Acme", jobTitle: "Backend Engineer" });
  });

  it("the text of an answer is given only for a final answer of another job", async () => {
    const here = await addJob("Globex", "Platform Engineer");
    const acme = await addJob("Acme", "Backend Engineer");
    const own = await answer(here, { question: "Q", text: "own final", final: true });
    const draft = await answer(acme, { question: "Q", text: "acme draft", final: false });
    const final = await answer(acme, { question: "Q2", text: "acme final", final: true });
    expect(await getReusableAnswerText(db(), { versionId: own.versionId, excludeJobId: here })).toBeNull();
    expect(await getReusableAnswerText(db(), { versionId: draft.versionId, excludeJobId: here })).toBeNull();
    expect(await getReusableAnswerText(db(), { versionId: 987654, excludeJobId: here })).toBeNull();
    expect(await getReusableAnswerText(db(), { versionId: final.versionId, excludeJobId: here })).toMatchObject({ text: "acme final", company: "Acme" });
    // from Acme's own page the same answer is not "another job's"
    expect(await getReusableAnswerText(db(), { versionId: final.versionId, excludeJobId: acme })).toBeNull();
  });

  it("names the job and company a version belongs to, and a deleted version is simply missing", async () => {
    const acme = await addJob("Acme", "Backend Engineer");
    const here = await addJob("Globex", "Platform Engineer");
    const source = await answer(acme, { question: "Why us?", text: "Acme answer", final: true });
    const started = await answer(here, { question: "Why us?", text: "Acme answer, edited", final: false, parentVersionId: source.versionId });
    const origins = await listVersionOrigins(db(), [source.versionId, started.versionId, 424242]);
    expect(origins.get(source.versionId)).toEqual({ jobId: acme, jobTitle: "Backend Engineer", company: "Acme" });
    expect(origins.get(started.versionId)).toMatchObject({ company: "Globex" });
    expect(origins.has(424242)).toBe(false);
    expect(await listVersionOrigins(db(), [])).toEqual(new Map());

    await db().delete(schema.jobs).where(eq(schema.jobs.id, acme));
    expect((await listVersionOrigins(db(), [source.versionId])).size).toBe(0);
  });
});
