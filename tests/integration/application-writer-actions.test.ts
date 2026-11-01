import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { findSimilarAnswersAction, saveBaseVersionAction } from "@/app/jobs/[id]/apply/actions";
import { writerSchema, type WriterConfig } from "@/lib/config";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createApplicationQuestion, insertAnswerVersions, listAnswerVersions, setFinalAnswerVersion } from "@/lib/db/repos/application-writer";
import { startedFrom } from "@/lib/writer/view";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const settings = vi.hoisted(() => ({ writer: null as unknown }));
// the files the actions read are the boundary here: each test says what writer.yaml is
vi.mock("@/lib/writer/settings", () => ({
  readWriterInputs: () => ({ writer: settings.writer, me: null, stories: [], storiesUnreadable: false, breakdownEnabled: false }),
  readWriterEnabled: () => (settings.writer as WriterConfig | null)?.enabled ?? false,
}));
vi.mock("@/lib/writer/company-names", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/writer/company-names")>()), legalSuffixes: () => ["gmbh", "inc"] }));

const url = inject("testDatabaseUrl");
const db = () => getDb();
const writer = (over: Record<string, unknown> = {}): WriterConfig => writerSchema.parse({ enabled: true, ...over });

async function addJob(company: string, title: string): Promise<number> {
  const [row] = await db().insert(schema.companies).values({ name: company, nameNorm: company.toLowerCase() }).returning();
  const [job] = await db().insert(schema.jobs).values({ companyId: row!.id, title, titleNorm: title.toLowerCase(), description: "d", language: "en" }).returning();
  return job!.id;
}

async function addQuestion(jobId: number, text: string) {
  return (await createApplicationQuestion(db(), {
    maxPerJob: 12,
    fields: { jobId, text, kind: "question", lengthUnit: "words", lengthValue: 150, outputLanguage: "en", tone: "neutral", selectedMaterials: {} },
  }))!;
}

async function addVersion(questionId: number, text: string, final: { jobId: number } | null, parentVersionId?: number) {
  const [id] = await insertAnswerVersions(db(), {
    questionId,
    maxVersions: 20,
    versions: [{ mode: "manual", text, sentences: [], ...(parentVersionId === undefined ? {} : { parentVersionId }) }],
  });
  if (final) await setFinalAnswerVersion(db(), { jobId: final.jobId, questionId, versionId: id! });
  return id!;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  settings.writer = writer();
  await db().execute(sql`truncate table jobs, companies restart identity cascade`);
});
afterAll(async () => {
  await db().execute(sql`truncate table jobs, companies restart identity cascade`);
  await closeDb();
});

describe("findSimilarAnswersAction", () => {
  it("rejects input that is not valid", async () => {
    for (const input of [{ jobId: 0, text: "Why us?" }, { jobId: -3, text: "Why us?" }, { jobId: 1.5, text: "Why us?" }, { jobId: 1, text: "   " }, { jobId: 1, text: "x".repeat(10_001) }, { jobId: 1, text: "Why us?", extra: true }]) {
      expect(await findSimilarAnswersAction(input as { jobId: number; text: string })).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("says why it did not look: writer.yaml unreadable, or the writer off", async () => {
    settings.writer = null;
    expect(await findSimilarAnswersAction({ jobId: 1, text: "Why do you want to join us?" })).toEqual({ ok: false, error: "config_error" });
    settings.writer = writer({ enabled: false });
    expect(await findSimilarAnswersAction({ jobId: 1, text: "Why do you want to join us?" })).toEqual({ ok: false, error: "disabled" });
  });

  it("offers the final answers of other jobs only, with the company's spellings, and nothing for a question under the word minimum", async () => {
    const here = await addJob("Globex", "Platform Engineer");
    const acme = await addJob("Acme GmbH", "Backend Engineer");
    const own = await addQuestion(here, "Why do you want to join Globex?");
    await addVersion(own.id, "own answer", { jobId: here });
    const question = await addQuestion(acme, "Why do you want to join Acme?");
    const versionId = await addVersion(question.id, "Acme answer", { jobId: acme });
    const draft = await addQuestion(acme, "Why do you want to join Acme right now?");
    await addVersion(draft.id, "never finalised", null);

    const result = await findSimilarAnswersAction({ jobId: here, text: "Why do you want to join Initech?" });
    expect(result).toEqual({
      ok: true,
      matches: [{ versionId, question: "Why do you want to join Acme?", answer: "Acme answer", company: "Acme GmbH", companyNames: ["Acme GmbH", "acme"], jobTitle: "Backend Engineer", percent: 75 }],
    });
    // from the other job's own page its own answer is not offered back; the first job's final answer is
    const fromAcme = await findSimilarAnswersAction({ jobId: acme, text: "Why do you want to join Acme?" });
    expect(fromAcme.ok && fromAcme.matches.map((match) => match.answer)).toEqual(["own answer"]);
    // fewer words than reuse.min_question_words: nothing is looked up
    settings.writer = writer({ reuse: { min_question_words: 8 } });
    expect(await findSimilarAnswersAction({ jobId: here, text: "Why do you want to join Initech?" })).toEqual({ ok: true, matches: [] });
  });
});

describe("saveBaseVersionAction", () => {
  async function scene() {
    const here = await addJob("Globex", "Platform Engineer");
    const other = await addJob("Acme", "Backend Engineer");
    const target = await addQuestion(here, "Why us?");
    const sourceQuestion = await addQuestion(other, "Why Acme?");
    const source = await addVersion(sourceQuestion.id, "Acme answer. Another sentence.", { jobId: other });
    return { here, other, target, sourceQuestion, source };
  }
  const rows = async (questionId: number) => listAnswerVersions(db(), [questionId]);

  it("rejects input that is not valid, and stores nothing", async () => {
    const { here, target, source } = await scene();
    for (const input of [
      { jobId: 0, questionId: target.id, sourceVersionId: source, text: "t" },
      { jobId: here, questionId: -1, sourceVersionId: source, text: "t" },
      { jobId: here, questionId: target.id, sourceVersionId: 0, text: "t" },
      { jobId: here, questionId: target.id, sourceVersionId: source, text: "   " },
      { jobId: here, questionId: target.id, sourceVersionId: source, text: "x".repeat(50_001) },
      { jobId: here, questionId: target.id, sourceVersionId: source, text: "t", extra: 1 },
    ]) {
      expect(await saveBaseVersionAction(input as Parameters<typeof saveBaseVersionAction>[0])).toEqual({ ok: false, error: "invalid" });
    }
    expect(await rows(target.id)).toEqual([]);
  });

  it("says config_error while writer.yaml cannot be read", async () => {
    const { here, target, source } = await scene();
    settings.writer = null;
    expect(await saveBaseVersionAction({ jobId: here, questionId: target.id, sourceVersionId: source, text: "t" })).toEqual({ ok: false, error: "config_error" });
    expect(await rows(target.id)).toEqual([]);
  });

  it("refuses a source that is not a final answer of another job, and a question that is not this job's", async () => {
    const { here, other, target, sourceQuestion, source } = await scene();
    const save = (over: Partial<Parameters<typeof saveBaseVersionAction>[0]>) => saveBaseVersionAction({ jobId: here, questionId: target.id, sourceVersionId: source, text: "My text.", ...over });
    const notFound = { ok: false, error: "not_found" };

    // a version that is not final (any more)
    const later = await addVersion(sourceQuestion.id, "A later, not final version", null);
    expect(await save({ sourceVersionId: later })).toEqual(notFound);
    // a version of this very job, final or not
    const ownVersion = await addVersion(target.id, "Own final", { jobId: here });
    expect(await save({ sourceVersionId: ownVersion })).toEqual(notFound);
    // a version that does not exist
    expect(await save({ sourceVersionId: 987_654 })).toEqual(notFound);
    // a question of another job, or one that does not exist
    const otherQuestion = await addQuestion(other, "Other job's question");
    expect(await save({ questionId: otherQuestion.id })).toEqual(notFound);
    expect(await save({ questionId: 987_654 })).toEqual(notFound);
    // nothing was stored by any of them, besides the version this test added itself
    expect((await rows(target.id)).map((row) => row.text)).toEqual(["Own final"]);
    expect((await rows(otherQuestion.id)).length).toBe(0);
  });

  it("stores the text as a manual version that points at the source, every sentence written by you", async () => {
    const { here, target, source } = await scene();
    const result = await saveBaseVersionAction({ jobId: here, questionId: target.id, sourceVersionId: source, text: "First sentence here. Second one follows!\n\nA new paragraph?" });
    expect(result).toMatchObject({ ok: true, versionId: expect.any(Number) });
    const [version] = await rows(target.id);
    expect(version).toMatchObject({
      id: result.ok ? (result as { versionId: number }).versionId : -1,
      mode: "manual",
      parentVersionId: source,
      variantId: null,
      controlRequestId: null,
      text: "First sentence here. Second one follows!\n\nA new paragraph?",
      supportedCount: 0,
      partialCount: 0,
      unsupportedCount: 0,
      framingCount: 0,
      webUnverifiedCount: 0,
      userWrittenCount: 3,
    });
    const sentences = version!.sentences as { text: string; status: string; evidence: unknown[]; newParagraph: boolean }[];
    expect(sentences.map((sentence) => [sentence.text, sentence.status, sentence.evidence.length, sentence.newParagraph])).toEqual([
      ["First sentence here.", "user_written", 0, false],
      ["Second one follows!", "user_written", 0, false],
      ["A new paragraph?", "user_written", 0, true],
    ]);
    // the source answer is untouched
    const [sourceRow] = await db().select().from(schema.applicationAnswerVersions).where(eq(schema.applicationAnswerVersions.id, source));
    expect(sourceRow?.text).toBe("Acme answer. Another sentence.");
  });
});

describe("startedFrom", () => {
  const origins = new Map([
    [10, { jobId: 2, jobTitle: "Backend Engineer", company: "Acme GmbH" }],
    [11, { jobId: 2, jobTitle: "Backend Engineer", company: "Acme GmbH" }],
    [12, { jobId: 3, jobTitle: "SRE", company: "Initech" }],
    [13, { jobId: 1, jobTitle: "Platform Engineer", company: "Globex" }],
  ]);

  it("names the other jobs a question was started from, oldest first, once per job, with the spellings to look for", () => {
    const versions = [{ parentVersionId: null }, { parentVersionId: 12 }, { parentVersionId: 10 }, { parentVersionId: 11 }].reverse(); // newest first, as the page reads them
    expect(startedFrom(versions, origins, 1, ["gmbh"])).toEqual([
      { company: "Initech", jobTitle: "SRE", names: ["Initech"] },
      { company: "Acme GmbH", jobTitle: "Backend Engineer", names: ["Acme GmbH", "acme"] },
    ]);
  });

  it("skips a parent in the same job, a missing origin and a version without a parent", () => {
    expect(startedFrom([{ parentVersionId: 13 }], origins, 1, [])).toEqual([]);
    expect(startedFrom([{ parentVersionId: 99 }], origins, 1, [])).toEqual([]);
    expect(startedFrom([{ parentVersionId: null }], origins, 1, [])).toEqual([]);
    expect(startedFrom([], origins, 1, [])).toEqual([]);
    expect(startedFrom([{ parentVersionId: 13 }, { parentVersionId: 99 }, { parentVersionId: 12 }], origins, 1, [])).toEqual([{ company: "Initech", jobTitle: "SRE", names: ["Initech"] }]);
  });
});
