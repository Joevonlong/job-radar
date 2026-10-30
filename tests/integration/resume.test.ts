import { withRebuiltCurrentScores } from "../helpers/current-scores";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getApplicationByJobId, setApplicationResumePath, setApplicationStatus, type ApplicationStatus } from "@/lib/db/repos/applications";
import { createUpdateHandler, runPoller } from "@/lib/notify/poller";
import { createTelegramClient, type TelegramUpdate } from "@/lib/notify/telegram-client";
import { prepareResumeKit, type PrepareOptions } from "@/lib/resume/export";

import { FakeBotApi, FAKE_TOKEN } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";
import { resumeConfig } from "../resume/helpers";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const CHAT = "555";
const api = new FakeBotApi();
const NOW = new Date("2026-10-07T10:00:00Z");

let exportDir: string;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  await api.start();
});

const resetTables = () => db().execute(sql`truncate table jobs, companies, applications restart identity cascade`);

beforeEach(async () => {
  await resetTables();
  api.reset();
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-jd-"));
});

afterEach(() => fs.rmSync(exportDir, { recursive: true, force: true }));

afterAll(async () => {
  await api.stop();
  await resetTables();
  await closeDb();
});

async function seedJob(input: { title: string; company?: string; description?: string | null }): Promise<number> {
  const name = input.company ?? "Acme GmbH";
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await db().insert(schema.companies).values({ name, nameNorm }).onConflictDoNothing({ target: schema.companies.nameNorm });
  const [company] = await db().select().from(schema.companies).where(eq(schema.companies.nameNorm, nameNorm));
  const [row] = await db()
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      title: input.title,
      titleNorm: input.title.toLowerCase(),
      locationsJson: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: true }],
      workplace: "hybrid",
      description: input.description === undefined ? "Build LLM agents.\n\nWe offer equity." : input.description,
    })
    .returning();
  const id = row!.id;
  await withRebuiltCurrentScores(db(), db().insert(schema.scores).values({ jobId: id, filterResult: "passed", score: 80, signalBonus: 4, rankValue: 84, summaryZh: "摘要" }));
  await db().insert(schema.signals).values({ jobId: id, tier: "T2", kind: "equity", quote: "We offer equity.", extractor: "rule" });
  return id;
}

const KIT = "/Users/me/dev/resume-kit";
const options = (over: Partial<PrepareOptions> = {}): PrepareOptions => ({
  config: resumeConfig((raw) => {
    raw.resume_kit_path = KIT;
    raw.jd_export_dir = exportDir;
  }),
  timeZone: "Europe/Berlin",
  now: () => NOW,
  source: "web",
  ...over,
});

const statusOf = async (jobId: number): Promise<ApplicationStatus | null> => (await getApplicationByJobId(db(), jobId))?.status ?? null;
const eventsOf = async (jobId: number) => {
  const application = await getApplicationByJobId(db(), jobId);
  return application ? await db().select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, application.id)) : [];
};

describe("prepareResumeKit", () => {
  it("writes front matter + the original JD to <company>-<title>-<date>.md and sets the status to preparing", async () => {
    const id = await seedJob({ title: "AI Engineer (m/w/d)", company: "Müller & Söhne GmbH" });
    const result = await prepareResumeKit(db(), id, options());
    if (!result.ok) throw new Error(result.error);

    expect(result.fileName).toBe("muller-sohne-gmbh-ai-engineer-m-w-d-2026-10-07.md");
    expect(result.filePath).toBe(path.join(exportDir, result.fileName));
    expect(result.command).toBe(`cd ${KIT} && claude --disallowed-tools=WebFetch,WebSearch "/tailor ${result.filePath}"`);

    const text = fs.readFileSync(result.filePath, "utf8");
    const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
    expect(match).not.toBeNull();
    expect(parse(match![1]!)).toMatchObject({
      job_id: id,
      company: "Müller & Söhne GmbH",
      role: "AI Engineer (m/w/d)",
      location: "Berlin, Germany",
      score: 84,
      signals: [{ tier: "T2", kind: "equity", quote: "We offer equity." }],
    });
    expect(match![2]).toContain("<untrusted_job_posting>\nBuild LLM agents.\n\nWe offer equity.\n</untrusted_job_posting>\n");

    expect(await statusOf(id)).toBe("preparing");
    const events = await eventsOf(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: "preparing", note: "web" });
    // only the export itself was written (no temp file left behind)
    expect(fs.readdirSync(exportDir)).toEqual([result.fileName]);
  });

  it("overwrites the same file on a repeated export and adds no second event", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    const first = await prepareResumeKit(db(), id, options());
    await db().update(schema.jobs).set({ description: "Updated JD text." }).where(eq(schema.jobs.id, id));
    const second = await prepareResumeKit(db(), id, options());
    if (!first.ok || !second.ok) throw new Error("export failed");

    expect(second.filePath).toBe(first.filePath);
    expect(fs.readdirSync(exportDir)).toHaveLength(1);
    expect(fs.readFileSync(second.filePath, "utf8")).toContain("Updated JD text.");
    expect(second.statusChange.changed).toBe(false);
    expect(await eventsOf(id)).toHaveLength(1);
  });

  it("does not overwrite the export of another job with the same company, title and day", async () => {
    const a = await seedJob({ title: "AI Engineer" });
    const b = await seedJob({ title: "AI Engineer", description: "Second posting." });
    const first = await prepareResumeKit(db(), a, options());
    const second = await prepareResumeKit(db(), b, options());
    if (!first.ok || !second.ok) throw new Error("export failed");

    expect(second.fileName).toBe(`acme-gmbh-ai-engineer-2026-10-07-${b}.md`);
    expect(fs.readFileSync(first.filePath, "utf8")).toContain("Build LLM agents.");
    expect(fs.readFileSync(second.filePath, "utf8")).toContain("Second posting.");
    // each of them keeps being rewritten in place
    const again = await prepareResumeKit(db(), b, options());
    expect(again.ok && again.fileName).toBe(second.fileName);
  });

  it("does not overwrite a file of the user that merely has the same name", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    const name = "acme-gmbh-ai-engineer-2026-10-07.md";
    fs.writeFileSync(path.join(exportDir, name), "my own notes\n");
    const result = await prepareResumeKit(db(), id, options());
    if (!result.ok) throw new Error(result.error);
    expect(result.fileName).toBe(`acme-gmbh-ai-engineer-2026-10-07-${id}.md`);
    expect(fs.readFileSync(path.join(exportDir, name), "utf8")).toBe("my own notes\n");
  });

  it("uses the day in the configured time zone and the host directory in the command", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    const late = () => new Date("2026-10-07T22:30:00Z");
    const result = await prepareResumeKit(db(), id, options({ now: late, config: resumeConfig((raw) => Object.assign(raw, { resume_kit_path: KIT, jd_export_dir: exportDir, jd_export_host_dir: "/Users/me/radar/exports" })) }));
    if (!result.ok) throw new Error(result.error);
    expect(result.fileName).toBe("acme-gmbh-ai-engineer-2026-10-08.md");
    expect(result.jdPath).toBe("/Users/me/radar/exports/acme-gmbh-ai-engineer-2026-10-08.md");
    expect(result.command).toContain('"/tailor /Users/me/radar/exports/acme-gmbh-ai-engineer-2026-10-08.md"');
  });

  it("never moves an application that is further along back to preparing, but still exports", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    await setApplicationStatus(db(), id, "applied");
    const result = await prepareResumeKit(db(), id, options());
    if (!result.ok) throw new Error(result.error);
    expect(result.statusChange).toMatchObject({ rejected: true, previous: "applied" });
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(await statusOf(id)).toBe("applied");
    expect(await eventsOf(id)).toHaveLength(1);
  });

  it("moves interested and archived applications to preparing", async () => {
    const a = await seedJob({ title: "A" });
    const b = await seedJob({ title: "B" });
    await setApplicationStatus(db(), a, "interested");
    await setApplicationStatus(db(), b, "archived");
    expect((await prepareResumeKit(db(), a, options())).ok).toBe(true);
    expect((await prepareResumeKit(db(), b, options())).ok).toBe(true);
    expect(await statusOf(a)).toBe("preparing");
    expect(await statusOf(b)).toBe("preparing");
  });

  it("answers not_found for an unknown job and write_failed when the directory cannot be written, changing nothing", async () => {
    expect(await prepareResumeKit(db(), 424242, options())).toEqual({ ok: false, error: "not_found" });
    const id = await seedJob({ title: "AI Engineer" });
    const blocker = path.join(exportDir, "blocked");
    fs.writeFileSync(blocker, "a file where the export directory should be");
    const result = await prepareResumeKit(db(), id, options({ config: resumeConfig((raw) => Object.assign(raw, { jd_export_dir: blocker })) }));
    expect(result).toEqual({ ok: false, error: "write_failed" });
    expect(await statusOf(id)).toBeNull();
  });

  it("gives no command while resume_kit_path is not configured", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    const result = await prepareResumeKit(db(), id, options({ config: resumeConfig((raw) => (raw.jd_export_dir = exportDir)) }));
    expect(result.ok && result.command).toBeNull();
  });
});

describe("setApplicationResumePath", () => {
  it("creates the application on the first attach without touching the status, and detaches again", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    await setApplicationResumePath(db(), id, "/pdfs/Acme.pdf");
    expect(await getApplicationByJobId(db(), id)).toMatchObject({ status: "new", resumeVariantPath: "/pdfs/Acme.pdf" });

    await setApplicationStatus(db(), id, "applied");
    await setApplicationResumePath(db(), id, "/pdfs/Acme-v2.pdf");
    expect(await getApplicationByJobId(db(), id)).toMatchObject({ status: "applied", resumeVariantPath: "/pdfs/Acme-v2.pdf" });

    await setApplicationResumePath(db(), id, null);
    expect((await getApplicationByJobId(db(), id))?.resumeVariantPath).toBeNull();
  });

  it("is safe when two attaches race on a job without an application", async () => {
    const id = await seedJob({ title: "AI Engineer" });
    await Promise.all([setApplicationResumePath(db(), id, "/pdfs/a.pdf"), setApplicationResumePath(db(), id, "/pdfs/b.pdf")]);
    const rows = await db().select().from(schema.applications).where(eq(schema.applications.jobId, id));
    expect(rows).toHaveLength(1);
    expect(["/pdfs/a.pdf", "/pdfs/b.pdf"]).toContain(rows[0]?.resumeVariantPath);
  });
});

describe("Telegram 📄 button", () => {
  const logs: string[] = [];
  const logger = createLogger({ minLevel: "debug", sink: (r) => logs.push(`${r.level} ${r.message} ${JSON.stringify(r.fields)}`) });
  const client = () => createTelegramClient({ token: FAKE_TOKEN, baseUrl: api.url, requestTimeoutMs: 3000, maxRetries: 0, sleep: async () => {} });

  const press = (jobId: number, updateId: number): TelegramUpdate => ({
    update_id: updateId,
    callback_query: { id: `cq-${updateId}`, from: { id: Number(CHAT) }, message: { message_id: 321, chat: { id: Number(CHAT) } }, data: `a:${jobId}:r` },
  });

  async function poll(updates: TelegramUpdate[], config: PrepareOptions["config"], done: () => boolean | Promise<boolean>): Promise<void> {
    const notify = notifyConfig((c) => Object.assign(c.telegram, { enabled: true, api_base_url: api.url, message_gap_ms: 0, max_retries: 0, poll_timeout_seconds: 1 }));
    const controller = new AbortController();
    const handler = createUpdateHandler({
      db: db(),
      client: client(),
      chatId: CHAT,
      logger,
      getConfig: () => notify,
      getWatchedKeys: () => new Set(),
      exportResume: (jobId, allowFrom) => prepareResumeKit(db(), jobId, { config, timeZone: "Europe/Berlin", now: () => NOW, source: "telegram", allowFrom }),
    });
    const running = runPoller({ client: client(), handler, logger, getConfig: () => notify, signal: controller.signal });
    for (const update of updates) api.pushUpdate(update);
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !(await done())) await new Promise((r) => setTimeout(r, 20));
    } finally {
      controller.abort();
      await running;
    }
  }

  it("exports the JD through the same function, marks preparing, and sends the command", async () => {
    const id = await seedJob({ title: "Button Role" });
    const config = options().config;
    await poll([press(id, 1)], config, () => api.of("sendMessage").length === 1);

    expect(await statusOf(id)).toBe("preparing");
    expect((await eventsOf(id))[0]).toMatchObject({ toStatus: "preparing", note: "telegram" });
    const file = path.join(exportDir, "acme-gmbh-button-role-2026-10-07.md");
    expect(fs.readFileSync(file, "utf8")).toContain("Build LLM agents.");

    expect(api.of("answerCallbackQuery")[0]?.body).toMatchObject({ text: "📄 已标记：准备中（定制简历）" });
    const edit = String(api.of("editMessageText")[0]?.body.text);
    expect(edit).toContain(`JD：${file}`);
    const message = api.of("sendMessage")[0]?.body;
    expect(message).toMatchObject({ chat_id: CHAT, parse_mode: "HTML" });
    expect(String(message?.text)).toContain(`<code>cd ${KIT} &amp;&amp; claude --disallowed-tools=WebFetch,WebSearch "/tailor ${file}"</code>`);
  });

  it("says how to configure resume-kit when there is no command, and leaves progress alone", async () => {
    const free = await seedJob({ title: "Free Role" });
    const applied = await seedJob({ title: "Applied Role" });
    await setApplicationStatus(db(), applied, "applied");
    const config = resumeConfig((raw) => (raw.jd_export_dir = exportDir));
    await poll([press(free, 1), press(applied, 2)], config, () => api.of("answerCallbackQuery").length === 2);

    expect(await statusOf(free)).toBe("preparing");
    expect(await statusOf(applied)).toBe("applied");
    expect(api.of("sendMessage").map((c) => String(c.body.text))).toEqual([expect.stringContaining("resume_kit_path")]);
    expect(api.of("answerCallbackQuery").map((c) => c.body.text)).toEqual(["📄 已标记：准备中（定制简历）", "当前状态是「已申请」，没有改动"]);
  });

  it("changes nothing and says so when the JD cannot be written", async () => {
    const id = await seedJob({ title: "Button Role" });
    const blocker = path.join(exportDir, "blocked");
    fs.writeFileSync(blocker, "x");
    const config = resumeConfig((raw) => Object.assign(raw, { resume_kit_path: KIT, jd_export_dir: blocker }));
    await poll([press(id, 1)], config, () => api.of("answerCallbackQuery").length === 1);
    expect(api.of("answerCallbackQuery")[0]?.body).toMatchObject({ text: "导出 JD 失败，没有改动" });
    expect(await statusOf(id)).toBeNull();
    expect(api.of("editMessageText")).toEqual([]);
  });
});
