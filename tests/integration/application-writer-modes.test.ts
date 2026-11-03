import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createAiRouter } from "@/lib/ai";
import { meSchema, storySchema, writerSchema, type WriterConfig } from "@/lib/config";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { createWriterJobHandler } from "@/lib/control/writer-job";
import { requestWriter, type WriterRequestSpec } from "@/lib/control/writer-request";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createApplicationQuestion, insertAnswerVersions, listAnswerVersions, setAnswerVersionCoach } from "@/lib/db/repos/application-writer";
import { parseStoredCoach } from "@/lib/writer/coach";

import { pinnedAi, scriptedProvider, type Step } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const db = () => getDb();

const JD = "Acme builds billing software. You will own our billing platform built on Kotlin.";
const MY_TEXT = "I moved our billing service to Kotlin. Errors fell by 40%.";

const writerOn = (over: Record<string, unknown> = {}): WriterConfig => writerSchema.parse({ enabled: true, ...over });
const me = meSchema.parse({ summary: "Backend engineer", skills: [{ name: "Kotlin", years: 6 }], languages: [{ en: "C2" }], years_experience: 6, city: "Berlin", needs_visa_sponsorship: true });
const stories = [storySchema.parse({ id: "billing", title: "Billing migration", what: "I led the migration of the billing service; errors fell by 40%.", skills: ["Kotlin"] })];

async function addJob(): Promise<number> {
  const [company] = await db().insert(schema.companies).values({ name: "Acme", nameNorm: "acme" }).returning();
  const [job] = await db().insert(schema.jobs).values({ companyId: company!.id, title: "Backend Engineer", titleNorm: "backend engineer", description: JD, language: "en" }).returning();
  return job!.id;
}

async function addQuestion(jobId: number) {
  return (await createApplicationQuestion(db(), {
    maxPerJob: 12,
    fields: {
      jobId,
      text: "Why do you want to join us?",
      kind: "question",
      lengthUnit: "words",
      lengthValue: 150,
      outputLanguage: "en",
      tone: "neutral",
      selectedMaterials: { jdPoints: [], useJdText: true, storyIds: ["billing"], profile: true, emphasis: "" },
    },
  }))!;
}

/** A stored version to review: two sentences of the user's own. */
async function addVersion(questionId: number, text = MY_TEXT): Promise<number> {
  const sentences = [
    { text: "I moved our billing service to Kotlin.", newParagraph: false, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [] },
    { text: "Errors fell by 40%.", newParagraph: false, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [] },
  ];
  const [id] = await insertAnswerVersions(db(), { questionId, maxVersions: 20, versions: [{ mode: "manual", text, sentences, userWrittenCount: 2 }] });
  return id!;
}

/** A version with a sentence the AI wrote without evidence (and one you wrote): the first must not back itself. */
async function addVersionWithUnbackedSentence(questionId: number): Promise<number> {
  const sentences = [
    { text: "I moved our billing service to Kotlin.", newParagraph: false, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [] },
    { text: "I cut latency by 60% at Siemens.", newParagraph: false, about: "user", status: "unsupported", evidence: [], missing: [], needsCheck: [] },
  ];
  const [id] = await insertAnswerVersions(db(), {
    questionId,
    maxVersions: 20,
    versions: [{ mode: "draft", text: "I moved our billing service to Kotlin. I cut latency by 60% at Siemens.", sentences, userWrittenCount: 1, unsupportedCount: 1 }],
  });
  return id!;
}

function handlerWith(steps: Step[], settings: WriterConfig = writerOn()) {
  const { provider, transport } = scriptedProvider("codex-cli", steps);
  registerControlHandler("writer_job", createWriterJobHandler({ createRouter: () => createAiRouter({ config: pinnedAi(), providers: [provider], usage: null }), loadSettings: () => settings }));
  return transport;
}

const poll = () => processNextControlRequest({ db: db(), signal: new AbortController().signal, logger: quietLogger, kinds: () => ["writer_job"] });

async function requestRow(id: number) {
  const [row] = await db().select().from(schema.controlRequests).where(eq(schema.controlRequests.id, id));
  return row!;
}

async function queue(jobId: number, questionId: number, spec: WriterRequestSpec, writer = writerOn()) {
  const outcome = await requestWriter(db(), { jobId, questionId, writer, me, stories }, spec);
  if (outcome.state !== "queued") throw new Error(`not queued: ${JSON.stringify(outcome)}`);
  return outcome.requestId;
}

/** What may remain of a request's payload once it ended: ids, the mode and the hash, never a text. */
function expectScrubbed(payload: unknown, ...texts: string[]): void {
  expect(payload).toMatchObject({ scrubbed: true, materialsHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(payload).not.toHaveProperty("materials");
  for (const text of texts) expect(JSON.stringify(payload)).not.toContain(text);
}

const polishReply = (id: string, sentences: object[]) => JSON.stringify({ variants: [{ variant_id: id, sentences }] });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  resetControlHandlers();
  await db().execute(sql`truncate table jobs, companies, control_requests, ai_usage restart identity cascade`);
});
afterAll(async () => {
  resetControlHandlers();
  await db().execute(sql`truncate table jobs, companies, control_requests, ai_usage restart identity cascade`);
  await closeDb();
});

describe("improve my draft", () => {
  it("fits the text to the job: the text is the evidence, the version is a polish one, the payload is cleared", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const transport = handlerWith([
      polishReply("align_to_job", [
        { text: "I moved our billing service to Kotlin.", about: "user", evidence: [{ source: "draft", quote: "moved our billing service to Kotlin" }] },
        { text: "Errors fell by 60%.", about: "user", evidence: [{ source: "draft", quote: "Errors fell by 40%" }] },
        { text: "The role owns the billing platform.", about: "role", evidence: [{ source: "jd", quote: "own our billing platform" }] },
      ]),
    ]);
    const requestId = await queue(jobId, question.id, { mode: "polish", option: "align_to_job", text: MY_TEXT });
    const pending = await requestRow(requestId);
    expect(pending.payload).toMatchObject({ mode: "polish", polish: "align_to_job", refs: { draft: true } });
    expect(JSON.stringify(pending.payload)).toContain("Errors fell by 40%");

    await poll();
    const row = await requestRow(requestId);
    expect(row.status).toBe("done");
    expectScrubbed(row.payload, "Errors fell by 40%", "Kotlin.");
    expect(JSON.stringify(row.result)).not.toContain("Errors fell");

    // the user's text and the chosen material both went into the input
    const sent = JSON.parse(transport.calls[0]!.user.replace(/^<application_input>\n|\n<\/application_input>$/g, "")) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["question", "settings", "job", "jd_excerpt", "profile", "stories", "draft"]);
    expect(sent.draft).toEqual({ text: MY_TEXT });
    expect(transport.calls[0]!.system).toContain("Keep every fact of the draft");

    const [version] = await listAnswerVersions(db(), [question.id]);
    expect(version).toMatchObject({ mode: "polish", variantId: "align_to_job", promptVersion: "write-polish-v1", controlRequestId: requestId });
    // backed by the draft, a figure that is not in the quote, a jd quote
    expect({ supported: version!.supportedCount, partial: version!.partialCount, unsupported: version!.unsupportedCount }).toEqual({ supported: 2, partial: 1, unsupported: 0 });
  });

  it("language only sends none of the chosen material, and a Chinese text backs the English sentences", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const transport = handlerWith([
      polishReply("language_only", [
        { text: "After the migration, errors fell by 40%.", about: "user", evidence: [{ source: "draft", quote: "错误下降了40%" }] },
        { text: "I joined Initech afterwards.", about: "user", evidence: [{ source: "draft", quote: "错误下降了40%" }] },
      ]),
    ]);
    const requestId = await queue(jobId, question.id, { mode: "polish", option: "language_only", text: "我把账单服务迁移之后，错误下降了40%。" });
    await poll();
    expect((await requestRow(requestId)).status).toBe("done");

    const sent = JSON.parse(transport.calls[0]!.user.replace(/^<application_input>\n|\n<\/application_input>$/g, "")) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["question", "settings", "job", "draft"]);
    expect(transport.calls[0]!.system).toContain("Do NOT add, remove or change any fact");

    const [version] = await listAnswerVersions(db(), [question.id]);
    expect(version).toMatchObject({ mode: "polish", variantId: "language_only" });
    const checked = version!.sentences as { status: string; needsCheck: string[]; missing: string[] }[];
    expect(checked[0]).toMatchObject({ status: "supported" });
    // a name the text does not have is flagged, like in any answer
    expect(checked[1]!.status).toBe("partial");
    expect(checked[1]!.needsCheck).toEqual(["Initech"]);
  });

  it("refuses an empty text and one over draft_max_chars, and queues nothing", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const input = { jobId, questionId: question.id, writer: writerOn({ draft_max_chars: 200 }), me, stories };
    expect(await requestWriter(db(), input, { mode: "polish", option: "align_to_job", text: "   " })).toEqual({ state: "error", error: "no_material" });
    expect(await requestWriter(db(), input, { mode: "polish", option: "align_to_job", text: "x".repeat(201) })).toEqual({ state: "error", error: "too_long" });
    expect(await requestWriter(db(), { ...input, writer: writerOn({ enabled: false }) }, { mode: "polish", option: "align_to_job", text: "hello" })).toEqual({ state: "error", error: "disabled" });
    expect(await db().select().from(schema.controlRequests)).toEqual([]);
  });
});

describe("coach review", () => {
  const review = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      score: 71.6,
      dimensions: [
        { id: "answers_question", status: "improve", note: "Half of it." },
        { id: "answers_question", status: "good", note: "A duplicate." },
        { id: "made_up", status: "good", note: "Not configured." },
        { id: "no_overclaim", status: "good", note: "Nothing overclaimed." },
      ],
      suggestions: [
        { sentence_index: 1, issue: "Name the project.", rewrite: "Errors fell by 40% after the move.", about: "user", evidence: [{ source: "draft", quote: "Errors fell by 40%" }] },
        { sentence_index: 0, issue: "Say how long.", rewrite: "I moved the billing service to Kotlin in two months.", about: "user", evidence: [] },
        { sentence_index: 9, issue: "No such sentence.", rewrite: "Nothing.", about: "framing", evidence: [] },
      ],
      ...over,
    });

  it("stores the score, the configured verdicts and the checked suggestions on the reviewed version, and clears the payload", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersion(question.id);
    const transport = handlerWith([review()]);
    const requestId = await queue(jobId, question.id, { mode: "coach", versionId });
    await poll();
    const row = await requestRow(requestId);
    expect(row.status).toBe("done");
    expectScrubbed(row.payload, "Errors fell by 40%");
    expect(row.payload).toMatchObject({ mode: "coach", versionId });
    expect(JSON.stringify(row.result)).not.toContain("Errors fell");

    const sent = JSON.parse(transport.calls[0]!.user.replace(/^<application_input>\n|\n<\/application_input>$/g, "")) as { draft: { sentences: unknown[] }; settings: Record<string, unknown> };
    expect(sent.draft.sentences).toEqual([
      { index: 0, text: "I moved our billing service to Kotlin." },
      { index: 1, text: "Errors fell by 40%." },
    ]);
    expect(sent.settings).not.toHaveProperty("versions");
    expect(transport.calls[0]!.system).toContain("- concrete_evidence: claims rest on concrete examples");

    const [stored] = await listAnswerVersions(db(), [question.id]);
    // no version was added: the review sits on the reviewed one
    expect(await listAnswerVersions(db(), [question.id])).toHaveLength(1);
    const coach = parseStoredCoach(stored!.coach)!;
    expect(coach.score).toBe(72);
    expect(coach.dimensions.map((entry) => entry.id)).toEqual(["answers_question", "no_overclaim"]);
    expect(coach.dropped).toEqual({ dimensions: 2, suggestions: 1 });
    expect(coach.promptVersion).toBe("write-coach-v1");
    expect(coach.suggestions.map((entry) => [entry.sentenceIndex, entry.sentence.status])).toEqual([
      [1, "supported"],
      [0, "ai_suggestion_unverified"],
    ]);
    expect(coach.suggestions[1]!.sentence.text).toBe("I moved the billing service to Kotlin in two months.");
    // the figures "two months" are words: not detected; the technology Kotlin is in no quote
    expect(coach.suggestions[1]!.sentence.evidence).toEqual([]);
  });

  it("an AI-written sentence without evidence in the reviewed version cannot back a suggestion by being quoted", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersionWithUnbackedSentence(question.id);
    handlerWith([
      review({
        suggestions: [
          { sentence_index: 1, issue: "Say it plainly.", rewrite: "I cut latency by 60% at Siemens.", about: "user", evidence: [{ source: "draft", quote: "I cut latency by 60% at Siemens" }] },
          { sentence_index: 0, issue: "Shorter.", rewrite: "I moved billing to Kotlin.", about: "user", evidence: [{ source: "draft", quote: "moved our billing service to Kotlin" }] },
        ],
      }),
    ]);
    const requestId = await queue(jobId, question.id, { mode: "coach", versionId });
    await poll();
    expect((await requestRow(requestId)).status).toBe("done");
    const coach = parseStoredCoach((await listAnswerVersions(db(), [question.id]))[0]!.coach)!;
    // the unbacked claim stays unverified; the sentence you wrote can still be quoted
    expect(coach.suggestions.map((entry) => [entry.sentenceIndex, entry.sentence.status])).toEqual([
      [1, "ai_suggestion_unverified"],
      [0, "supported"],
    ]);
  });

  it("a score outside 0-100 is a malformed answer, not a review", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersion(question.id);
    handlerWith([review({ score: 140 }), review({ score: 140 }), review({ score: 140 })]);
    const requestId = await queue(jobId, question.id, { mode: "coach", versionId });
    await poll();
    const row = await requestRow(requestId);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "invalid_output" });
    expectScrubbed(row.payload);
    expect((await listAnswerVersions(db(), [question.id]))[0]!.coach).toBeNull();
  });

  it("a version of another question cannot be reviewed", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const other = await addQuestion(jobId);
    const versionId = await addVersion(other.id);
    expect(await requestWriter(db(), { jobId, questionId: question.id, writer: writerOn(), me, stories }, { mode: "coach", versionId })).toEqual({ state: "error", error: "not_found" });
  });

  it("the version removed while the review ran ends as not found and stores nothing", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersion(question.id);
    handlerWith([review()]);
    const requestId = await queue(jobId, question.id, { mode: "coach", versionId });
    await db().delete(schema.applicationAnswerVersions).where(eq(schema.applicationAnswerVersions.id, versionId));
    await poll();
    expect((await requestRow(requestId)).result).toMatchObject({ error: "not_found" });
  });
});

describe("one open request per question", () => {
  it("concurrent clicks leave one request: the AI is called once, the other click joins it", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const input = { jobId, questionId: question.id, writer: writerOn(), me, stories };
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => requestWriter(db(), input, { mode: "draft" })));
    const rows = await db().select().from(schema.controlRequests).where(eq(schema.controlRequests.kind, "writer_job"));
    expect(rows).toHaveLength(1);
    expect(outcomes.map((outcome) => (outcome.state === "queued" ? outcome.requestId : null))).toEqual(outcomes.map(() => rows[0]!.id));
    expect(outcomes.filter((outcome) => outcome.state === "queued" && !outcome.existing)).toHaveLength(1);
  });

  it("writing again joins the open write; a polish or a review while any request is open is refused as busy", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersion(question.id);
    const input = { jobId, questionId: question.id, writer: writerOn(), me, stories };
    const first = await requestWriter(db(), input, { mode: "draft" });
    expect(first).toMatchObject({ state: "queued", existing: false });
    expect(await requestWriter(db(), input, { mode: "draft" })).toEqual({ state: "queued", requestId: (first as { requestId: number }).requestId, existing: true });
    expect(await requestWriter(db(), input, { mode: "polish", option: "align_to_job", text: MY_TEXT })).toEqual({ state: "error", error: "busy" });
    expect(await requestWriter(db(), input, { mode: "coach", versionId })).toEqual({ state: "error", error: "busy" });
    expect(await db().select().from(schema.controlRequests)).toHaveLength(1);
  });

  it("a write is not joined to another device's open polish or review", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const input = { jobId, questionId: question.id, writer: writerOn(), me, stories };
    await queue(jobId, question.id, { mode: "polish", option: "align_to_job", text: MY_TEXT });
    expect(await requestWriter(db(), input, { mode: "draft" })).toEqual({ state: "error", error: "busy" });
  });
});

describe("rewrite by the review", () => {
  const rewriteReply = JSON.stringify({
    variants: [
      {
        variant_id: "coach_rewrite",
        sentences: [
          { text: "I moved our billing service to Kotlin.", about: "user", evidence: [{ source: "draft", quote: "moved our billing service to Kotlin" }] },
          { text: "Errors fell by 40% after the move.", about: "user", evidence: [{ source: "draft", quote: "Errors fell by 40%" }] },
        ],
      },
    ],
  });

  it("needs a review with suggestions; its version points at the reviewed one and is checked like a draft", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersion(question.id);
    const spec: WriterRequestSpec = { mode: "coach_rewrite", versionId };
    expect(await requestWriter(db(), { jobId, questionId: question.id, writer: writerOn(), me, stories }, spec)).toEqual({ state: "error", error: "no_material" });

    const suggestion = { sentenceIndex: 1, issue: "Name the project.", sentence: { text: "Errors fell by 40% after the move.", newParagraph: false, about: "user", status: "supported", evidence: [], missing: [], needsCheck: [] } };
    await setAnswerVersionCoach(db(), { questionId: question.id, versionId, coach: { score: 60, dimensions: [], suggestions: [suggestion], dropped: { dimensions: 0, suggestions: 0 }, provider: null, model: null, promptVersion: null, createdAt: new Date().toISOString() } });

    const transport = handlerWith([rewriteReply]);
    const requestId = await queue(jobId, question.id, spec);
    expect((await requestRow(requestId)).payload).toMatchObject({ mode: "coach_rewrite", versionId });
    await poll();
    const row = await requestRow(requestId);
    expect(row.status).toBe("done");
    expectScrubbed(row.payload, "after the move");

    const sent = JSON.parse(transport.calls[0]!.user.replace(/^<application_input>\n|\n<\/application_input>$/g, "")) as { draft: { suggestions: unknown[] } };
    expect(sent.draft.suggestions).toEqual([{ index: 1, issue: "Name the project.", rewrite: "Errors fell by 40% after the move." }]);

    const versions = await listAnswerVersions(db(), [question.id]);
    const written = versions.find((entry) => entry.mode === "coach_rewrite")!;
    expect(written).toMatchObject({ variantId: "coach_rewrite", parentVersionId: versionId, promptVersion: "write-coach-rewrite-v1", supportedCount: 2 });
    expect(written.text).toBe("I moved our billing service to Kotlin. Errors fell by 40% after the move.");
  });

  it("a sentence of the reviewed version without evidence cannot back itself in the rewrite", async () => {
    const jobId = await addJob();
    const question = await addQuestion(jobId);
    const versionId = await addVersionWithUnbackedSentence(question.id);
    const suggestion = { sentenceIndex: 0, issue: "Shorter.", sentence: { text: "I moved billing to Kotlin.", newParagraph: false, about: "user", status: "supported", evidence: [], missing: [], needsCheck: [] } };
    await setAnswerVersionCoach(db(), { questionId: question.id, versionId, coach: { score: 60, dimensions: [], suggestions: [suggestion], dropped: { dimensions: 0, suggestions: 0 }, provider: null, model: null, promptVersion: null, createdAt: new Date().toISOString() } });
    handlerWith([
      JSON.stringify({
        variants: [
          {
            variant_id: "coach_rewrite",
            sentences: [
              { text: "I moved billing to Kotlin.", about: "user", evidence: [{ source: "draft", quote: "moved our billing service to Kotlin" }] },
              { text: "I cut latency by 60% at Siemens.", about: "user", evidence: [{ source: "draft", quote: "I cut latency by 60% at Siemens" }] },
            ],
          },
        ],
      }),
    ]);
    const requestId = await queue(jobId, question.id, { mode: "coach_rewrite", versionId });
    await poll();
    expect((await requestRow(requestId)).status).toBe("done");
    const written = (await listAnswerVersions(db(), [question.id])).find((entry) => entry.mode === "coach_rewrite")!;
    expect({ supported: written.supportedCount, unsupported: written.unsupportedCount }).toEqual({ supported: 1, unsupported: 1 });
  });
});
