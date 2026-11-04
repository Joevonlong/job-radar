import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { POST } from "@/app/api/me/story-extract/route";
import { AiProviderError, createAiRouter } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import { readProfileText, reloadConfig, resetConfigCache, writerSchema, type WriterConfig } from "@/lib/config";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { expireScrubbedRequests } from "@/lib/control/expire";
import { createStoryExtractHandler } from "@/lib/control/story-extract";
import { readOpenStoryExtract, readStoryExtractRequest, requestStoryExtract } from "@/lib/control/story-extract-request";
import { closeDb, getDb, hashProfileYaml, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { claimNextControlRequest, requeueInterruptedControlRequests } from "@/lib/db/repos/control-requests";
import { deleteExpiredStoryDrafts, discardStoryDraft, insertStoryDrafts, listPendingStoryDrafts } from "@/lib/db/repos/story-drafts";
import { adoptStoryDraft, loadPendingStoryDrafts } from "@/lib/stories/adopt";
import { enterUpload } from "@/lib/stories/upload-gate";

import { pinnedAi, scriptedProvider, type Step } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";
import { minimalPdf } from "../fixtures/pdf";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const MARKER = "QX-SOURCE-MARKER-7731";
const SOURCE = `${MARKER} Moved the billing service to the new platform. Errors fell by 40% in the first quarter.`;
const writerOn = (patch: Partial<WriterConfig> = {}): WriterConfig => ({ ...writerSchema.parse({ enabled: true }), ...patch });
const field = (value: string, quote: string) => ({ value, quote });

const reply = (): Step => ({
  text: JSON.stringify({
    drafts: [
      { title: field("Moved billing", "Moved the billing service"), what: field("Moved the billing service", "Moved the billing service to the new platform."), result: field("Errors fell by 40%", "Errors fell by 40%"), period: null, metrics: [], skills: [], language: "en" },
      { title: field("Invented", "not in the source"), what: field("Errors fell by 60%", "Errors fell by 40%"), result: null, period: null, metrics: [], skills: [], language: "en" },
    ],
  }),
});

function handlerWith(steps: Step[], settings = writerOn()) {
  const { provider, transport } = scriptedProvider("codex-cli", steps);
  registerControlHandler("story_extract", createStoryExtractHandler({ createRouter: () => createAiRouter({ config: pinnedAi(), providers: [provider], usage: null }), loadSettings: () => settings }));
  return transport;
}

const poll = () => processNextControlRequest({ db: db(), signal: new AbortController().signal, logger: quietLogger, kinds: () => ["story_extract"] });

async function queue(text = SOURCE, writer = writerOn()): Promise<number> {
  const outcome = await requestStoryExtract(db(), { origin: "resume", text, writer });
  if (outcome.state !== "queued") throw new Error(`not queued: ${outcome.error}`);
  return outcome.requestId;
}

async function requestRow(id: number) {
  const [row] = await db().select().from(schema.controlRequests).where(eq(schema.controlRequests.id, id));
  return row!;
}

/** What may remain of a request's payload once it ended: the origin, the hash and the length. */
function expectScrubbed(payload: unknown): void {
  expect(payload).toEqual({ origin: "resume", sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/), sourceChars: SOURCE.length, truncated: false, scrubbed: true });
}

/** The source in any row of any table, whatever the column. */
async function tablesHolding(marker: string): Promise<string[]> {
  const tables = await db().execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '__drizzle_migrations'`);
  const out: string[] = [];
  for (const { table_name: table } of tables) {
    const [row] = await db().execute<{ found: boolean }>(sql`select exists (select 1 from ${sql.identifier(table)} t where t::text like ${`%${marker}%`}) as found`);
    if (row?.found) out.push(table);
  }
  return out;
}

/** Files below `root` changed since `since` that hold the marker. */
function filesHolding(root: string, marker: string, since: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(at);
        // a directory that gained a file since has a new time itself
        if (entry.isDirectory() && depth > 0 && stat.mtimeMs >= since) walk(at, depth - 1);
        if (!entry.isFile()) continue;
        if (stat.mtimeMs >= since && stat.size < 5_000_000 && fs.readFileSync(at).includes(marker)) found.push(at);
      } catch {
        // gone meanwhile (another test's temp file)
      }
    }
  };
  walk(root, 3);
  return found;
}

function upload(fields: Record<string, string | File>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("http://127.0.0.1/api/me/story-extract", { method: "POST", body: form });
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-story-extract-"));
const configDir = path.join(scratch, "config");
const profileDir = path.join(scratch, "profile");
const env = { config: process.env.JOB_RADAR_CONFIG_DIR, profile: process.env.JOB_RADAR_PROFILE_DIR };
const ME = "languages: []\nskills:\n  - { name: Go, years: 5 }\nyears_experience: 5\ncity: Berlin\nneeds_visa_sponsorship: false\nsummary: Backend engineer who moved billing systems to new platforms.\n";

function writerFile(text: string): void {
  fs.writeFileSync(path.join(configDir, "writer.yaml"), text);
  resetConfigCache();
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  process.env.JOB_RADAR_CONFIG_DIR = configDir;
  process.env.JOB_RADAR_PROFILE_DIR = profileDir;
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  resetControlHandlers();
  writerFile("enabled: true\n");
  fs.writeFileSync(path.join(profileDir, "me.yaml"), ME);
  fs.writeFileSync(path.join(profileDir, "stories.yaml"), "stories:\n  - id: moved-billing\n    title: Moved billing\n    what: Written by hand before.\n");
  resetConfigCache();
  await db().delete(schema.controlRequests);
  await db().delete(schema.profileStoryDrafts);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

afterAll(async () => {
  await closeDb();
  process.env.JOB_RADAR_CONFIG_DIR = env.config;
  process.env.JOB_RADAR_PROFILE_DIR = env.profile;
  resetConfigCache();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("extraction: the five ways a request ends leave no text", () => {
  it("after success: only the hash and length remain, the drafts wait for review, stories.yaml is unchanged", async () => {
    const before = readProfileText("stories");
    handlerWith([reply()]);
    const id = await queue();
    expect((await requestRow(id)).payload).toMatchObject({ text: SOURCE });
    expect(await poll()).toMatchObject({ id, status: "done" });
    const row = await requestRow(id);
    expectScrubbed(row.payload);
    expect(row.result).toMatchObject({ origin: "resume", drafts: 2, flagged: 1 });
    expect(await readStoryExtractRequest(db(), id)).toEqual({ state: "done", drafts: 2 });
    const drafts = await loadPendingStoryDrafts(db());
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ origin: "resume", draft: { title: { value: "Moved billing", flag: null } } });
    expect(drafts[1]).toMatchObject({ draft: { title: { flag: "quote_missing" }, what: { flag: "figure_missing", missing: ["60%"] } } });
    expect(readProfileText("stories")).toBe(before);
    expect(await tablesHolding(MARKER)).toEqual([]);
  });

  it("after an AI failure: scrubbed, and the provider's error text is not kept", async () => {
    handlerWith([new AiProviderError("codex-cli", "provider_error", `failed on ${MARKER}`)]);
    const id = await queue();
    expect(await poll()).toMatchObject({ id, status: "failed" });
    const row = await requestRow(id);
    expectScrubbed(row.payload);
    expect(JSON.stringify(row.result)).not.toContain(MARKER);
    expect(await tablesHolding(MARKER)).toEqual([]);
  });

  it("after the handler's timeout: scrubbed", async () => {
    // a provider that never answers, and a limit that has passed by the time the worker calls it
    const silent = { run: (_task: unknown, _prompt: unknown, _schema: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("stopped")))) } as unknown as AiRouter;
    registerControlHandler("story_extract", createStoryExtractHandler({ createRouter: () => silent, loadSettings: () => writerOn({ timeout_seconds: 0.05 }) }));
    const id = await queue();
    expect(await poll()).toMatchObject({ id, status: "failed" });
    const row = await requestRow(id);
    expectScrubbed(row.payload);
    expect(row.result).toMatchObject({ error: "timeout" });
    expect(await tablesHolding(MARKER)).toEqual([]);
  });

  it("after a restart: failed rather than queued again, and scrubbed", async () => {
    handlerWith([]);
    const id = await queue();
    await claimNextControlRequest(db(), ["story_extract"], { lane: "interactive" });
    expect(await requeueInterruptedControlRequests(db(), { reason: "ai-worker restarted", maxRequeues: 3, kinds: ["story_extract"] })).toEqual({ requeued: 0, failed: 1 });
    const row = await requestRow(id);
    expect(row.status).toBe("failed");
    expectScrubbed(row.payload);
    expect(await tablesHolding(MARKER)).toEqual([]);
  });

  it("never claimed: expires in the queue, also with no ai-worker running, and scrubbed", async () => {
    const id = await queue();
    await db().update(schema.controlRequests).set({ requestedAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.controlRequests.id, id));
    expect(await expireScrubbedRequests(db())).toBe(1);
    const row = await requestRow(id);
    expect(row).toMatchObject({ status: "failed", result: { error: "expired" } });
    expectScrubbed(row.payload);
    expect(await tablesHolding(MARKER)).toEqual([]);
    expect(await readStoryExtractRequest(db(), id)).toMatchObject({ state: "failed", error: "expired" });
  });
});

describe("queueing", () => {
  it("runs one at a time: the same text joins, another is refused", async () => {
    const id = await queue();
    expect(await requestStoryExtract(db(), { origin: "resume", text: SOURCE, writer: writerOn() })).toMatchObject({ state: "queued", requestId: id, existing: true });
    expect(await requestStoryExtract(db(), { origin: "resume", text: `${SOURCE} More.`, writer: writerOn() })).toEqual({ state: "error", error: "busy" });
    expect(await readOpenStoryExtract(db())).toMatchObject({ requestId: id, stage: "pending" });
  });

  it("cuts a long text, says so, and hashes what is sent", async () => {
    const writer = writerSchema.parse({ enabled: true, import: { max_chars: 1000 } });
    const outcome = await requestStoryExtract(db(), { origin: "self_description", text: "x".repeat(1500), writer });
    expect(outcome).toMatchObject({ state: "queued", truncated: true });
    if (outcome.state !== "queued") throw new Error("not queued");
    expect((await requestRow(outcome.requestId)).payload).toMatchObject({ sourceChars: 1000, truncated: true });
  });

  it("refuses with the writer off, without leaving a request", async () => {
    expect(await requestStoryExtract(db(), { origin: "resume", text: SOURCE, writer: writerSchema.parse({ enabled: false }) })).toEqual({ state: "error", error: "disabled" });
    expect(await db().select().from(schema.controlRequests)).toEqual([]);
  });

  it("extracting the same text again replaces its waiting drafts", async () => {
    handlerWith([reply(), reply()]);
    await queue();
    await poll();
    await queue();
    await poll();
    expect(await listPendingStoryDrafts(db())).toHaveLength(2);
  });
});

describe("the upload route", () => {
  it("takes a PDF, writes no file and puts its text in the request only", async () => {
    const started = Date.now() - 1000;
    const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "writeFile"), vi.spyOn(fs.promises, "writeFile"), vi.spyOn(fs, "createWriteStream"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs.promises, "appendFile")];
    syncBuiltinESMExports();
    const pdf = minimalPdf([`${MARKER} Moved the billing service.`]);
    const response = await POST(upload({ origin: "resume", file: new File([pdf.slice()], "my-cv.pdf", { type: "application/pdf" }) }));
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; requestId: number; truncated: boolean };
    expect(body).toMatchObject({ ok: true, truncated: false });
    const row = await requestRow(body.requestId);
    expect(row.kind).toBe("story_extract");
    expect((row.payload as { text: string }).text).toContain(MARKER);
    expect(JSON.stringify(row.payload)).not.toContain("my-cv");
    expect(await tablesHolding(MARKER)).toEqual(["control_requests"]);
    expect(filesHolding(os.tmpdir(), MARKER, started)).toEqual([]);
    expect(filesHolding(path.resolve("data"), MARKER, started)).toEqual([]);
  });

  it("takes pasted text and Markdown, and assembles the profile on the server", async () => {
    const pasted = await POST(upload({ origin: "self_description", text: SOURCE }));
    expect(pasted.status).toBe(200);
    await db().delete(schema.controlRequests);
    const markdown = await POST(upload({ origin: "resume", file: new File([`# CV\n${SOURCE}`], "cv.md") }));
    expect(markdown.status).toBe(200);
    await db().delete(schema.controlRequests);
    const profile = await POST(upload({ origin: "profile", text: "ignored: the server builds this" }));
    const body = (await profile.json()) as { requestId: number };
    const row = await requestRow(body.requestId);
    expect((row.payload as { text: string }).text).toBe("Backend engineer who moved billing systems to new platforms.\n\nSkills: Go");
    expect(row.payload).toMatchObject({ origin: "profile" });
  });

  it("reads only import.max_concurrent_uploads files at once and turns the rest away, then reads again", async () => {
    writerFile("enabled: true\nimport:\n  max_concurrent_uploads: 1\n");
    const file = () => upload({ origin: "resume", file: new File([minimalPdf([`${MARKER} Moved the billing service.`]).slice()], "cv.pdf") });
    // the slot is held explicitly, so nothing depends on how fast a PDF is read
    const held = enterUpload(1);
    expect(held).not.toBeNull();
    const refused = await POST(file());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ ok: false, error: "too_many" });
    // pasted text has no file and needs no slot
    expect((await POST(upload({ origin: "self_description", text: SOURCE }))).status).toBe(200);
    await db().delete(schema.controlRequests);
    held?.();
    // the slot is back once the first is done, also after a refusal
    expect((await POST(file())).status).toBe(200);
    writerFile("enabled: true\n");
    await db().delete(schema.controlRequests);
  });

  it("refuses too large, wrong types, scans and damaged files, without leaving a request", async () => {
    writerFile("enabled: true\nimport:\n  max_file_bytes: 10000\n");
    const refused = async (fields: Record<string, string | File>) => {
      const response = await POST(upload(fields));
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    expect(await refused({ origin: "resume", file: new File(["x".repeat(10_001)], "cv.txt") })).toEqual([413, "too_large"]);
    expect(await refused({ origin: "resume", file: new File(["x".repeat(40_000)], "cv.txt") })).toEqual([413, "too_large"]);
    expect(await refused({ origin: "resume", file: new File(["some words that are long enough"], "cv.docx") })).toEqual([415, "bad_type"]);
    expect(await refused({ origin: "resume", file: new File(["some words that are long enough"], "cv.pdf") })).toEqual([415, "bad_type"]);
    expect(await refused({ origin: "resume", file: new File([minimalPdf([]).slice()], "scan.pdf") })).toEqual([422, "no_text"]);
    expect(await refused({ origin: "resume", file: new File(["%PDF-1.7 broken"], "bad.pdf") })).toEqual([422, "unreadable"]);
    expect(await refused({ origin: "self_description", text: "short" })).toEqual([422, "no_text"]);
    expect(await refused({ origin: "web", text: SOURCE })).toEqual([400, "invalid"]);
    expect(await db().select().from(schema.controlRequests)).toEqual([]);
  });

  it("honours the formats of writer.yaml", async () => {
    writerFile("enabled: true\nimport:\n  formats: [txt]\n");
    const response = await POST(upload({ origin: "resume", file: new File(["# Moved the billing service."], "cv.md") }));
    expect(response.status).toBe(415);
  });

  it("sends nothing with the writer off", async () => {
    writerFile("enabled: false\n");
    const response = await POST(upload({ origin: "self_description", text: SOURCE }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "disabled" });
    expect(await db().select().from(schema.controlRequests)).toEqual([]);
  });
});

describe("the review", () => {
  async function drafts() {
    handlerWith([reply()]);
    await queue();
    await poll();
    return loadPendingStoryDrafts(db());
  }
  const baseHash = () => hashProfileYaml(readProfileText("stories"));

  it("adopting adds a story with a new id, never over one with the same title, and clears the draft", async () => {
    const [first] = await drafts();
    expect(await adoptStoryDraft(db(), { draftId: first!.id, baseHash: baseHash() })).toMatchObject({ state: "saved" });
    resetConfigCache();
    const stories = reloadConfig("stories").stories;
    expect(stories.map((story) => story.id)).toEqual(["moved-billing", "moved-billing-2"]);
    expect(stories[0]?.what).toBe("Written by hand before.");
    expect(stories[1]).toMatchObject({ source: "resume", result: "Errors fell by 40%" });
    const [row] = await db().select().from(schema.profileStoryDrafts).where(eq(schema.profileStoryDrafts.id, first!.id));
    expect(row).toMatchObject({ status: "adopted", draft: {} });
    expect(await adoptStoryDraft(db(), { draftId: first!.id, baseHash: baseHash() })).toEqual({ state: "not_found" });
  });

  it("adopts your edits, but the id and the source stay the server's", async () => {
    const [first] = await drafts();
    const edited = { title: "Billing, edited", what: "Mine.", result: "", period: "2021", metrics: ["3 days"], skills: ["Go"], language: "en" };
    expect(await adoptStoryDraft(db(), { draftId: first!.id, baseHash: baseHash(), edited })).toMatchObject({ state: "saved" });
    resetConfigCache();
    expect(reloadConfig("stories").stories[1]).toMatchObject({ id: "billing-edited", title: "Billing, edited", source: "resume", metrics: ["3 days"] });
  });

  it("a stale page or an edit over the limits changes nothing, and the draft waits again", async () => {
    const [first, second] = await drafts();
    expect(await adoptStoryDraft(db(), { draftId: first!.id, baseHash: "old" })).toMatchObject({ state: "refused", result: { status: "error", formError: "stale" } });
    const edited = { title: "", what: "Mine.", result: "", period: "", metrics: [], skills: [], language: "" };
    expect(await adoptStoryDraft(db(), { draftId: second!.id, baseHash: baseHash(), edited })).toMatchObject({ state: "refused", result: { status: "error" } });
    expect(await loadPendingStoryDrafts(db())).toHaveLength(2);
    resetConfigCache();
    expect(reloadConfig("stories").stories).toHaveLength(1);
  });

  it("discarding takes the text with it", async () => {
    const [first] = await drafts();
    expect(await discardStoryDraft(db(), first!.id)).toBe(true);
    expect(await discardStoryDraft(db(), first!.id)).toBe(false);
    const [row] = await db().select().from(schema.profileStoryDrafts).where(eq(schema.profileStoryDrafts.id, first!.id));
    expect(row).toMatchObject({ status: "discarded", draft: {} });
  });

  it("expired rows go, whatever their status; newer ones stay", async () => {
    await insertStoryDrafts(db(), { origin: "resume", sourceHash: "a", drafts: [{}, {}] });
    const [old] = await db().select().from(schema.profileStoryDrafts);
    await db().update(schema.profileStoryDrafts).set({ createdAt: new Date(Date.now() - 15 * 86_400_000) }).where(eq(schema.profileStoryDrafts.id, old!.id));
    expect(await deleteExpiredStoryDrafts(db(), 14)).toBe(1);
    expect(await deleteExpiredStoryDrafts(db(), 14)).toBe(0);
    expect(await db().select().from(schema.profileStoryDrafts)).toHaveLength(1);
  });
});
