import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { adoptSuggestionAction, findSimilarAnswersAction, saveBaseVersionAction, saveManualVersionAction } from "@/app/jobs/[id]/apply/actions";
import { writerSchema, type WriterConfig } from "@/lib/config";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createApplicationQuestion, insertAnswerVersions, listAnswerVersions, setAnswerVersionCoach, setFinalAnswerVersion } from "@/lib/db/repos/application-writer";
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

describe("saving a version while the writer is off", () => {
  it("is refused like the rest of the workbench, and stores nothing; the writer on, both save", async () => {
    const oldJob = await addJob("Acme GmbH", "Engineer");
    const oldQuestion = await addQuestion(oldJob, "Why do you want to join us?");
    const final = await addVersion(oldQuestion.id, "I like Acme.", { jobId: oldJob });
    const job = await addJob("Initech", "Engineer");
    const question = await addQuestion(job, "Why do you want to join?");
    const parent = await addVersion(question.id, "A first text.", null);

    settings.writer = writer({ enabled: false });
    expect(await saveManualVersionAction({ jobId: job, questionId: question.id, parentVersionId: parent, text: "Edited." })).toEqual({ ok: false, error: "disabled" });
    expect(await saveBaseVersionAction({ jobId: job, questionId: question.id, sourceVersionId: final, text: "Started." })).toEqual({ ok: false, error: "disabled" });
    expect(await listAnswerVersions(db(), [question.id])).toHaveLength(1);

    settings.writer = writer();
    expect(await saveManualVersionAction({ jobId: job, questionId: question.id, parentVersionId: parent, text: "Edited." })).toMatchObject({ ok: true });
    expect(await saveBaseVersionAction({ jobId: job, questionId: question.id, sourceVersionId: final, text: "Started." })).toMatchObject({ ok: true });
    expect(await listAnswerVersions(db(), [question.id])).toHaveLength(3);
  });
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
      matches: [{ versionId, question: "Why do you want to join Acme?", answer: "Acme answer", company: "Acme GmbH", companyNames: ["Acme GmbH", "acme"], jobTitle: "Backend Engineer", percent: 60 }],
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

describe("adoptSuggestionAction", () => {
  const sentence = (text: string, status: string, over: Record<string, unknown> = {}) => ({ text, newParagraph: false, about: "user", status, evidence: [], missing: [], needsCheck: [], ...over });
  const suggestion = (sentenceIndex: number, text: string, status: string, over: Record<string, unknown> = {}) => ({ sentenceIndex, issue: "Be direct.", sentence: sentence(text, status, over) });

  async function reviewed() {
    const jobId = await addJob("Acme", "Backend Engineer");
    const question = await addQuestion(jobId, "Why us?");
    const sentences = [sentence("I moved the billing service.", "supported"), sentence("Errors fell a lot.", "unsupported")];
    const [versionId] = await insertAnswerVersions(db(), {
      questionId: question.id,
      maxVersions: 20,
      versions: [{ mode: "draft", variantId: "safe", text: "I moved the billing service. Errors fell a lot.", sentences, supportedCount: 1, unsupportedCount: 1, materialsHash: "h" }],
    });
    await setAnswerVersionCoach(db(), {
      questionId: question.id,
      versionId: versionId!,
      coach: {
        score: 60,
        dimensions: [],
        suggestions: [
          suggestion(1, "Errors fell by 40%.", "supported", { evidence: [{ source: "draft", quote: "Errors fell by 40%", problem: null }] }),
          suggestion(0, "I moved it in two months.", "ai_suggestion_unverified"),
        ],
        dropped: { dimensions: 0, suggestions: 0 },
        provider: null,
        model: null,
        promptVersion: null,
        createdAt: new Date().toISOString(),
      },
    });
    return { jobId, question, versionId: versionId! };
  }

  it("rejects input that is not valid", async () => {
    for (const input of [{ jobId: 0, questionId: 1, versionId: 1, suggestionIndex: 0 }, { jobId: 1, questionId: 1, versionId: 1, suggestionIndex: -1 }, { jobId: 1, questionId: 1, versionId: 1, suggestionIndex: 0.5 }, { jobId: 1, questionId: 1, versionId: 1, suggestionIndex: 0, extra: 1 }]) {
      expect(await adoptSuggestionAction(input as never)).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("saves a manual version with the suggested sentence in place and the suggestion's own check result; the reviewed version stays as it was", async () => {
    const { jobId, question, versionId } = await reviewed();
    const result = await adoptSuggestionAction({ jobId, questionId: question.id, versionId, suggestionIndex: 0 });
    expect(result).toMatchObject({ ok: true, versionId: expect.any(Number) });
    const versions = await listAnswerVersions(db(), [question.id]);
    const adopted = versions.find((row) => row.mode === "manual")!;
    expect(adopted).toMatchObject({ text: "I moved the billing service. Errors fell by 40%.", parentVersionId: versionId, variantId: "safe", supportedCount: 2, unsupportedCount: 0 });
    expect((adopted.sentences as { status: string }[]).map((entry) => entry.status)).toEqual(["supported", "supported"]);
    const original = versions.find((row) => row.id === versionId)!;
    expect(original.text).toBe("I moved the billing service. Errors fell a lot.");
    expect(original.coach).not.toBeNull();
  });

  it("an unverified suggestion keeps that status, counted among the sentences without evidence", async () => {
    const { jobId, question, versionId } = await reviewed();
    await adoptSuggestionAction({ jobId, questionId: question.id, versionId, suggestionIndex: 1 });
    const adopted = (await listAnswerVersions(db(), [question.id])).find((row) => row.mode === "manual")!;
    expect((adopted.sentences as { status: string }[]).map((entry) => entry.status)).toEqual(["ai_suggestion_unverified", "unsupported"]);
    expect(adopted.text).toBe("I moved it in two months. Errors fell a lot.");
    expect(adopted.unsupportedCount).toBe(2);
  });

  it("finds nothing for another job's question, a suggestion that is not there, or a version with no review", async () => {
    const { jobId, question, versionId } = await reviewed();
    const otherJob = await addJob("Globex", "Platform Engineer");
    expect(await adoptSuggestionAction({ jobId: otherJob, questionId: question.id, versionId, suggestionIndex: 0 })).toEqual({ ok: false, error: "not_found" });
    expect(await adoptSuggestionAction({ jobId, questionId: question.id, versionId, suggestionIndex: 5 })).toEqual({ ok: false, error: "not_found" });
    const plain = await addVersion(question.id, "plain", null);
    expect(await adoptSuggestionAction({ jobId, questionId: question.id, versionId: plain, suggestionIndex: 0 })).toEqual({ ok: false, error: "not_found" });
    expect((await listAnswerVersions(db(), [question.id])).filter((row) => row.mode === "manual" && row.parentVersionId === versionId)).toEqual([]);
  });

  it("says why when writer.yaml cannot be read", async () => {
    const { jobId, question, versionId } = await reviewed();
    settings.writer = null;
    expect(await adoptSuggestionAction({ jobId, questionId: question.id, versionId, suggestionIndex: 0 })).toEqual({ ok: false, error: "config_error" });
  });
});
