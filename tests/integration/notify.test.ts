import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { NotifyConfig } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { setApplicationStatus, type ApplicationStatus } from "@/lib/db/repos/applications";
import { addFavorite, getFavorite } from "@/lib/db/repos/favorites";
import { saveCircuitState, upsertChannelRows } from "@/lib/db/repos/channels";
import { createUpdateHandler, runPoller } from "@/lib/notify/poller";
import { runReminders } from "@/lib/notify/reminders";
import { createNotifyStep, type NotifyStepResult } from "@/lib/notify/step";
import { createTelegramClient, type TelegramUpdate } from "@/lib/notify/telegram-client";
import type { NotifyDeps } from "@/lib/notify/types";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { FakeBotApi, FAKE_TOKEN } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";

const url = inject("testDatabaseUrl");
const CHAT = "555";
const api = new FakeBotApi();
const db = () => getDb();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  await api.start();
});

const resetTables = () => db().execute(sql`truncate table jobs, companies, cycles, channels, notifications, applications, ai_usage restart identity cascade`);

beforeEach(async () => {
  await resetTables();
  api.reset();
  resetCycleSteps();
});

afterEach(() => resetCycleSteps());

afterAll(async () => {
  await api.stop();
  await resetTables(); // other integration files expect empty tables
  await closeDb();
});

// ---------------------------------------------------------------- helpers

/** notify.yaml pointed at the fake API: Telegram on, no pauses between messages. */
function config(edit: (c: { telegram: Record<string, unknown>; quiet_hours: Record<string, unknown> } & Record<string, unknown>) => void = () => {}): NotifyConfig {
  return notifyConfig((c) => {
    Object.assign(c.telegram, { enabled: true, api_base_url: api.url, message_gap_ms: 0, max_retries: 0, poll_timeout_seconds: 1 });
    Object.assign(c.quiet_hours, { enabled: false });
    edit(c);
  });
}

const client = () => createTelegramClient({ token: FAKE_TOKEN, baseUrl: api.url, requestTimeoutMs: 30_000, maxRetries: 0, sleep: async () => {} });

function useStep(notify: NotifyConfig): void {
  registerCycleStep(
    "notify",
    createNotifyStep({ loadNotifyConfig: () => notify, createRuntime: () => ({ client: client(), chatId: CHAT }), sleep: async () => {} }),
  );
}

async function cycle(options: { now?: () => Date } = {}) {
  return runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, sleep: async () => {}, ...options });
}
const stepResult = (result: Awaited<ReturnType<typeof cycle>>) => result.results.notify as NotifyStepResult;
const stepOf = (result: Awaited<ReturnType<typeof cycle>>) => result.summary.steps.find((s) => s.name === "notify");

interface SeedJob {
  title: string;
  company?: string;
  watched?: boolean;
  /** undefined: no score row. */
  rank?: number;
  match?: number;
  bonus?: number;
  filter?: "passed" | "filtered_out";
  tiers?: Array<"T1" | "T2" | "T3" | "T4" | "tag">;
  firstSeenAt?: Date;
  germanLevel?: string;
  /** Normalized yearly EUR range, for the 💰 badge. */
  salary?: [number, number];
}

async function seedJob(job: SeedJob): Promise<number> {
  const name = job.company ?? "Acme GmbH";
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await db().insert(schema.companies).values({ name, nameNorm, watched: job.watched ?? false }).onConflictDoNothing({ target: schema.companies.nameNorm });
  const [company] = await db().select().from(schema.companies).where(eq(schema.companies.nameNorm, nameNorm));
  const [row] = await db()
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      title: job.title,
      titleNorm: job.title.toLowerCase(),
      locationsJson: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: true }],
      workplace: "hybrid",
      germanLevelRequired: job.germanLevel ?? "none",
      salaryJson: job.salary
        ? {
            raw: "salary",
            currency: "EUR",
            period: "year",
            min: job.salary[0],
            max: job.salary[1],
            perYear: { min: job.salary[0], max: job.salary[1] },
            eurPerYear: { min: job.salary[0], max: job.salary[1] },
            periodAssumed: false,
            origin: "text",
            qualityStatus: "valid",
            reasonCodes: [],
          }
        : null,
      // a minute ahead of the cycle so the job counts as "new" in the cycle that follows
      firstSeenAt: job.firstSeenAt ?? new Date(Date.now() + 60_000),
    })
    .returning();
  const id = row!.id;
  if (job.rank !== undefined || job.filter !== undefined) {
    await db().insert(schema.scores).values({
      jobId: id,
      filterResult: job.filter ?? "passed",
      score: job.match ?? job.rank ?? null,
      signalBonus: job.bonus ?? 0,
      rankValue: job.rank ?? null,
      summaryZh: `${job.title} 的摘要`,
    });
  }
  for (const tier of job.tiers ?? []) {
    await db().insert(schema.signals).values({ jobId: id, tier, kind: "test", quote: "quoted text", extractor: "rule" });
  }
  return id;
}

const texts = (method = "sendMessage") => api.of(method).map((c) => String(c.body.text ?? ""));
const notificationKinds = async () => (await db().select().from(schema.notifications).orderBy(schema.notifications.id)).map((n) => n.kind);

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for the condition");
}

// ---------------------------------------------------------------- the notify step

describe("notify step: summary and job messages", () => {
  async function seedScenario() {
    const ids = {
      best: await seedJob({ title: "Best ML Engineer", rank: 85, match: 78, bonus: 7, tiers: ["T1", "T3", "tag"], salary: [85000, 105000], germanLevel: "B2" }),
      t1: await seedJob({ title: "Signal Engineer", rank: 75, tiers: ["T1"] }),
      ok: await seedJob({ title: "Okay Engineer", rank: 72 }),
      relaxed: await seedJob({ title: "Relaxed T1 Engineer", rank: 62, tiers: ["T2"] }),
      low: await seedJob({ title: "Low Engineer", rank: 50 }),
      filtered: await seedJob({ title: "Filtered Engineer", rank: 95, filter: "filtered_out" }),
      unscored: await seedJob({ title: "Unscored Engineer" }),
      watched: await seedJob({ title: "Watched Role", company: "Watched AG", watched: true }),
    };
    return ids;
  }

  it("sends one summary and one message per qualifying job, best first, capped and recorded", async () => {
    const ids = await seedScenario();
    useStep(config((c) => (c.max_per_cycle = 3)));
    const result = await cycle();

    expect(stepOf(result)?.status).toBe("ok");
    const sent = texts();
    expect(sent).toHaveLength(4);
    expect(sent[0]).toContain("手动轮");
    expect(sent[0]).toContain("新岗位 8 · 通过过滤 5 · 合格 4（本条之后推送 3 条）");
    expect(sent[0]).toContain("另有 2 条待推送岗位超过每轮上限");
    expect(sent[1]).toContain("<b>🎯 85</b> <i>（匹配 78 + 信号 7）</i>  💰 €85–105k · 🏅 有竞争力 · 需德语 B2");
    expect(sent[1]).toContain("<b>Best ML Engineer</b>");
    expect(sent[1]).toContain("Acme GmbH · Berlin · Hybrid");
    expect(sent[1]).toContain("Best ML Engineer 的摘要");
    expect(sent[2]).toContain("Signal Engineer");
    expect(sent[3]).toContain("Okay Engineer");
    expect(sent.join("\n")).not.toMatch(/Low Engineer|Filtered Engineer|Unscored Engineer/);

    // job messages carry the three buttons, the summary none
    const calls = api.of("sendMessage");
    expect(calls[0]?.body.reply_markup).toBeUndefined();
    expect(JSON.stringify(calls[1]?.body.reply_markup)).toContain(`a:${ids.best}:i`);
    expect(calls.every((c) => c.body.chat_id === CHAT && c.body.parse_mode === "HTML")).toBe(true);

    expect(await notificationKinds()).toEqual(["cycle_summary", "job", "job", "job", "job_overflow"]);
    const rows = await db().select().from(schema.notifications).orderBy(schema.notifications.id);
    expect(rows.slice(1, 4).map((r) => (r.payloadJson as { jobId: number }).jobId)).toEqual([ids.best, ids.t1, ids.ok]);
    expect(rows.slice(0, 4).map((r) => r.telegramMessageId)).toEqual([100, 101, 102, 103]);
    expect((rows[4]?.payloadJson as { jobId: number }).jobId).toBe(ids.relaxed);
    expect(stepResult(result).jobs).toMatchObject({ newJobs: 8, qualified: 4, pushed: 3, overflow: 2, failed: 0 });
  });

  it("never pushes the same job twice, never pushes cut jobs later, and still pushes a watched job once it is the only one left", async () => {
    const ids = await seedScenario();
    useStep(config((c) => (c.max_per_cycle = 3)));
    await cycle();
    api.reset();

    await cycle();
    const sent = texts();
    expect(sent).toHaveLength(2); // summary + the watched job that had no score yet (and so was not cut for good)
    expect(sent[1]).toContain("Watched Role");
    expect(sent[1]).toContain("<b>未评分</b>  👀 关注");
    api.reset();

    await cycle();
    expect(texts()).toHaveLength(1); // only the summary
    const pushed = (await db().select().from(schema.notifications).where(eq(schema.notifications.kind, "job"))).map((n) => (n.payloadJson as { jobId: number }).jobId);
    expect(pushed.sort((a, b) => a - b)).toEqual([ids.best, ids.t1, ids.ok, ids.watched].sort((a, b) => a - b));
  });

  it("pushes an older job once it gets its score late (\"score now\", backlog), but not one scored long ago", async () => {
    const old = new Date(Date.now() - 5 * 86_400_000);
    const late = await seedJob({ title: "Scored Late Engineer", rank: 86, firstSeenAt: old });
    const stale = await seedJob({ title: "Scored Long Ago Engineer", rank: 90, firstSeenAt: old });
    await db().update(schema.scores).set({ scoredAt: new Date() }).where(eq(schema.scores.jobId, late));
    await db().update(schema.scores).set({ scoredAt: old }).where(eq(schema.scores.jobId, stale));
    useStep(config());
    await cycle();
    const sent = texts().join("\n");
    expect(sent).toContain("Scored Late Engineer");
    expect(sent).not.toContain("Scored Long Ago Engineer");
  });

  it("links to the dashboard when public_base_url is set", async () => {
    const id = await seedJob({ title: "Linked Role", rank: 90 });
    useStep(config((c) => (c.public_base_url = "https://radar.example-tailnet.ts.net")));
    await cycle();
    expect(texts()[1]).toContain(`<a href="https://radar.example-tailnet.ts.net/jobs/${id}">打开详情</a>`);
    expect(texts()[0]).toContain('<a href="https://radar.example-tailnet.ts.net">打开看板</a>');
  });

  it("lists failed sources from the collect step in the summary", async () => {
    await seedJob({ title: "Some Role", rank: 90 });
    useStep(config());
    // a stand-in for the collect step's result
    registerCycleStep("collect", async () => ({
      status: "partial",
      result: { channels: { "linkedin-brightdata": { failed: 2, errorCodes: { rate_limited: 2 } } }, unusable: {} },
    }));
    await cycle();
    expect(texts()[0]).toContain("⚠️ 失败的来源：linkedin-brightdata（rate_limited）");
  });

  it("does nothing when Telegram is disabled, and reports a missing configuration", async () => {
    await seedJob({ title: "Some Role", rank: 90 });
    useStep({ ...notifyConfig(), telegram: { ...notifyConfig().telegram, enabled: false } });
    const disabled = await cycle();
    expect(stepResult(disabled)).toEqual({ skipped: "disabled" });
    expect(api.calls).toEqual([]);

    registerCycleStep("notify", createNotifyStep({ loadNotifyConfig: () => config(), createRuntime: () => null }));
    const missing = await cycle();
    expect(stepResult(missing)).toMatchObject({ skipped: "not_configured", retry: { since: expect.any(String), startedAt: expect.any(String) } });
    expect(stepOf(missing)?.status).toBe("partial");
    expect(await notificationKinds()).toEqual([]);
  });

  it("keeps jobs for a later cycle when Telegram fails, and retries them", async () => {
    await seedJob({ title: "Retry Role", rank: 90 });
    useStep(config());

    api.failNext("sendMessage", 500, { ok: false, error_code: 500, description: "down" }, 100);
    const failed = await cycle();
    expect(stepOf(failed)?.status).toBe("partial");
    expect(await notificationKinds()).toEqual([]);

    api.reset();
    const ok = await cycle();
    expect(stepOf(ok)?.status).toBe("ok");
    expect(await notificationKinds()).toEqual(["cycle_summary", "job"]);
    expect(texts()[1]).toContain("Retry Role");
  });

  it("is partial when one job message fails but still sends the others", async () => {
    await seedJob({ title: "First Role", rank: 90 });
    await seedJob({ title: "Second Role", rank: 80 });
    let calls = 0;
    registerCycleStep(
      "notify",
      createNotifyStep({
        loadNotifyConfig: () => config(),
        createRuntime: () => {
          const real = client();
          // the summary (call 1) and the second job (call 3) go through; the first job (call 2) fails
          return {
            chatId: CHAT,
            client: {
              ...real,
              sendMessage: async (input) => {
                calls += 1;
                if (calls === 2) throw new Error("boom");
                return real.sendMessage(input);
              },
            },
          };
        },
        sleep: async () => {},
      }),
    );
    const result = await cycle();
    expect(stepOf(result)?.status).toBe("partial");
    expect(stepResult(result).jobs).toMatchObject({ pushed: 1, failed: 1 });
    expect(await notificationKinds()).toEqual(["cycle_summary", "job"]);
    expect(texts().at(-1)).toContain("Second Role");
  });

  it("does not send a second summary for a cycle that already has one", async () => {
    await seedJob({ title: "Some Role", rank: 90 });
    const step = createNotifyStep({ loadNotifyConfig: () => config(), createRuntime: () => ({ client: client(), chatId: CHAT }), sleep: async () => {} });
    let second: unknown;
    registerCycleStep("notify", async (ctx) => {
      await step(ctx);
      second = (await step(ctx))?.result;
    });
    await cycle();
    expect((second as NotifyStepResult).jobs).toEqual({ deferred: "already_sent" });
    expect(texts()).toHaveLength(2); // one summary, one job
  });
});

describe("notify step: quiet hours", () => {
  /** HH:MM of `date` in Europe/Berlin. */
  const berlinClock = (date: Date): string =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

  const quietAround = (c: { quiet_hours: Record<string, unknown> }): void => {
    const now = Date.now();
    Object.assign(c.quiet_hours, { enabled: true, start: berlinClock(new Date(now - 2 * HOUR)), end: berlinClock(new Date(now + 2 * HOUR)) });
  };

  it("holds job messages back during quiet hours and pushes them in the first cycle after", async () => {
    await seedJob({ title: "Night Role", rank: 90 });
    useStep(config(quietAround));
    const quiet = await cycle();
    expect(stepResult(quiet).jobs).toEqual({ deferred: "quiet_hours" });
    expect(api.calls).toEqual([]);
    expect(await notificationKinds()).toEqual([]);

    useStep(config()); // quiet hours are over
    await cycle();
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain("Night Role");
  });

  it("still sends alerts during quiet hours when alerts_exempt is on, and holds them back when it is off", async () => {
    await upsertChannelRows(db(), [{ id: "linkedin-brightdata", family: "linkedin", kind: "paid", enabled: true }]);
    await saveCircuitState(db(), "linkedin-brightdata", {
      circuitState: "open",
      consecutiveFailures: 3,
      circuitOpenUntil: new Date(Date.now() + DAY),
      lastErrorCode: "rate_limited",
      lastSuccessAt: null,
      health: "down",
    });

    useStep(config((c) => (quietAround(c), Object.assign(c.quiet_hours, { alerts_exempt: false }))));
    const held = await cycle();
    expect(stepResult(held).alerts).toMatchObject({ quiet: true, sent: 0 });
    expect(api.calls).toEqual([]);

    useStep(config((c) => (quietAround(c), Object.assign(c.quiet_hours, { alerts_exempt: true }))));
    const sent = await cycle();
    expect(stepResult(sent).alerts).toMatchObject({ sent: 1, quiet: false });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("通道 linkedin-brightdata 已熔断");
    expect(texts()[0]).toContain("rate_limited");
  });
});

describe("notify step: alerts", () => {
  async function openCircuit(): Promise<void> {
    await upsertChannelRows(db(), [{ id: "linkedin-brightdata", family: "linkedin", kind: "paid", enabled: true }]);
    await saveCircuitState(db(), "linkedin-brightdata", {
      circuitState: "open",
      consecutiveFailures: 3,
      circuitOpenUntil: new Date(Date.now() + 2 * DAY),
      lastErrorCode: "blocked",
      lastSuccessAt: null,
      health: "down",
    });
  }

  it("sends an alert once per 24 hours for the same kind and key", async () => {
    await openCircuit();
    useStep(config());

    const first = await cycle();
    expect(stepResult(first).alerts).toMatchObject({ sent: 1, deduped: 0 });
    expect(texts().filter((t) => t.includes("已熔断"))).toHaveLength(1);
    expect(await notificationKinds()).toContain("alert:circuit_open");

    api.reset();
    const second = await cycle();
    expect(stepResult(second).alerts).toMatchObject({ sent: 0, deduped: 1 });
    expect(texts().some((t) => t.includes("已熔断"))).toBe(false);

    api.reset();
    const later = await cycle({ now: () => new Date(Date.now() + 25 * HOUR) });
    expect(stepResult(later).alerts).toMatchObject({ sent: 1, deduped: 0 });
    expect(texts().some((t) => t.includes("已熔断"))).toBe(true);
  });

  it("alerts for an expired login and a budget at 80% from the database state", async () => {
    await upsertChannelRows(db(), [{ id: "linkedin-brightdata", family: "linkedin", kind: "paid", enabled: true }]);
    // fixture-style stand-in for collect: the brightdata channel failed with auth_expired
    registerCycleStep("collect", async () => ({ status: "partial", result: { channels: { "linkedin-brightdata": { failed: 1, errorCodes: { auth_expired: 1 } } }, unusable: {} } }));
    // 85% of the AI API budget
    const budget = (await import("@/lib/config")).loadConfig("ai").monthly_api_budget_usd;
    await db().insert(schema.aiUsage).values({ provider: "anthropic", task: "score", costEstimate: budget * 0.85 });
    useStep(config());

    await cycle();
    const alerts = texts().filter((t) => t.startsWith("🚨"));
    expect(alerts.some((t) => t.includes("linkedin-brightdata 的登录态或凭据失效"))).toBe(true);
    expect(alerts.some((t) => t.includes("AI API 预算已用 85%"))).toBe(true);
    expect(await notificationKinds()).toEqual(expect.arrayContaining(["alert:auth_expired", "alert:budget_80"]));
  });

  it("alerts when every AI provider failed", async () => {
    registerCycleStep("ai", async () => ({
      status: "failed",
      result: { subtasks: [{ name: "score", status: "failed", error: 'AiUnavailableError: no AI provider could handle task "score": claude-cli failed' }] },
    }));
    useStep(config());
    await cycle();
    expect(texts().some((t) => t.includes("AI provider 全部失败"))).toBe(true);
  });
});

describe("notify step: alerts queued by other features", () => {
  const queue = (kind: string, payload: unknown) => db().insert(schema.notifications).values({ kind, payloadJson: payload, sentAt: null });
  const rows = () => db().select().from(schema.notifications).orderBy(schema.notifications.id);

  it("delivers unsent alert.* rows, marks them sent with the Telegram message id and leaves other rows alone", async () => {
    await queue("alert.backup_failed", { key: "nightly", title: "备份失败", detail: "pg_dump exited with 1" });
    await queue("alert.restore_check", null); // no payload at all
    await queue("something.else", {}); // not an alert
    useStep(config());

    const result = await cycle();
    expect(stepResult(result).alerts).toMatchObject({ sent: 2, deduped: 0, failed: 0 });
    const alerts = texts().filter((t) => t.startsWith("🚨"));
    expect(alerts).toEqual(["🚨 <b>备份失败</b>\npg_dump exited with 1", "🚨 <b>告警：restore_check</b>\n"]);

    const [backup, restore, other] = await rows();
    expect(backup).toMatchObject({ kind: "alert.backup_failed", telegramMessageId: 100 });
    expect(backup?.sentAt).not.toBeNull();
    expect(restore?.telegramMessageId).toBe(101);
    expect(other).toMatchObject({ kind: "something.else", sentAt: null, telegramMessageId: null });

    api.reset();
    await cycle();
    expect(texts().some((t) => t.startsWith("🚨"))).toBe(false); // nothing is sent twice
  });

  it("dedupes queued alerts by kind and key: duplicates are closed without a message, and the window applies", async () => {
    await queue("alert.backup_failed", { key: "nightly", title: "备份失败", detail: "first" });
    await queue("alert.backup_failed", { key: "nightly", title: "备份失败", detail: "second" });
    await queue("alert.backup_failed", { key: "weekly", title: "备份失败", detail: "other key" });
    useStep(config());

    expect(stepResult(await cycle()).alerts).toMatchObject({ sent: 2, deduped: 1 });
    expect(texts().filter((t) => t.startsWith("🚨")).map((t) => t.split("\n")[1])).toEqual(["first", "other key"]);
    const closed = (await rows())[1];
    expect(closed).toMatchObject({ telegramMessageId: null, payloadJson: { deduped: true } });
    expect(closed?.sentAt).not.toBeNull();

    // the same alert again within 24 h is closed unsent; a deduped row does not extend the window
    api.reset();
    await queue("alert.backup_failed", { key: "nightly", title: "备份失败", detail: "third" });
    expect(stepResult(await cycle()).alerts).toMatchObject({ sent: 0, deduped: 1 });
    expect(texts().some((t) => t.startsWith("🚨"))).toBe(false);

    api.reset();
    await queue("alert.backup_failed", { key: "nightly", title: "备份失败", detail: "fourth" });
    expect(stepResult(await cycle({ now: () => new Date(Date.now() + 25 * HOUR) })).alerts).toMatchObject({ sent: 1 });
    expect(texts().filter((t) => t.startsWith("🚨"))[0]).toContain("fourth");
  });

  it("keeps a queued alert unsent when the send fails, so the next cycle retries it", async () => {
    await queue("alert.backup_failed", { key: "nightly", title: "备份失败", detail: "x" });
    useStep(config());
    api.failNext("sendMessage", 400, { ok: false, error_code: 400, description: "nope" }, 1);
    expect(stepResult(await cycle()).alerts).toMatchObject({ sent: 0, failed: 1 });
    expect((await rows())[0]?.sentAt).toBeNull();
    api.reset();
    expect(stepResult(await cycle()).alerts).toMatchObject({ sent: 1 });
    expect((await rows())[0]?.telegramMessageId).not.toBeNull();
  });
});

// ---------------------------------------------------------------- inline buttons

describe("button presses (long polling)", () => {
  const logs: string[] = [];
  const logger = createLogger({ minLevel: "debug", sink: (r) => logs.push(`${r.level} ${r.message} ${JSON.stringify(r.fields)}`) });

  beforeEach(() => {
    logs.length = 0;
  });

  const callback = (jobId: number, code: "i" | "x" | "r" | "f" | "u", chat = Number(CHAT), updateId = 1000 + Math.floor(Math.random() * 1e6)): TelegramUpdate => ({
    update_id: updateId,
    callback_query: { id: `cq-${updateId}`, from: { id: chat }, message: { message_id: 321, chat: { id: chat } }, data: `a:${jobId}:${code}` },
  });

  /** Run the poller against the fake API until `done` holds, then shut it down. */
  async function poll(updates: TelegramUpdate[], done: () => Promise<boolean>, allowedUserIds: readonly number[] | null = null): Promise<void> {
    const notify = config();
    const controller = new AbortController();
    const handler = createUpdateHandler({ db: db(), client: client(), chatId: CHAT, allowedUserIds, logger, getConfig: () => notify, getWatchedKeys: () => new Set() });
    const running = runPoller({ client: client(), handler, logger, getConfig: () => notify, signal: controller.signal });
    for (const update of updates) api.pushUpdate(update);
    try {
      await waitFor(done);
    } finally {
      controller.abort();
      await running;
    }
  }

  const statusOf = async (jobId: number): Promise<ApplicationStatus | null> =>
    (await db().select().from(schema.applications).where(eq(schema.applications.jobId, jobId)))[0]?.status ?? null;

  it("marks a job as interested, answers the press and edits the message to 'marked'", async () => {
    const id = await seedJob({ title: "Button Role", rank: 88, match: 80, bonus: 8, tiers: ["T2"] });
    await poll([callback(id, "i")], async () => (await statusOf(id)) === "interested" && api.of("editMessageText").length === 1);

    const [application] = await db().select().from(schema.applications).where(eq(schema.applications.jobId, id));
    expect(application?.status).toBe("interested");
    const events = await db().select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, application!.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: "interested", note: "telegram" });

    expect(api.of("answerCallbackQuery")[0]?.body).toMatchObject({ text: "👍 已标记：感兴趣" });
    const edit = api.of("editMessageText")[0]?.body;
    expect(edit).toMatchObject({ chat_id: CHAT, message_id: 321, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
    expect(String(edit?.text)).toContain("<b>Button Role</b>");
    expect(String(edit?.text)).toContain("<b>🎯 88</b>");
    expect(String(edit?.text)).toContain("📈 股权");
    expect(String(edit?.text).endsWith("\n\n👍 已标记：感兴趣")).toBe(true);
  });

  it("with TELEGRAM_ALLOWED_USER_IDS only the listed users' presses count, even inside the configured chat", async () => {
    const blocked = await seedJob({ title: "Blocked Press", rank: 88, match: 80, bonus: 8, tiers: ["T2"] });
    const allowed = await seedJob({ title: "Allowed Press", rank: 88, match: 80, bonus: 8, tiers: ["T2"] });
    const stranger = callback(blocked, "i");
    stranger.callback_query!.from = { id: 999 }; // same chat, a user that is not on the list
    const member = callback(allowed, "i");
    member.callback_query!.from = { id: 777 };
    await poll([stranger, member], async () => (await statusOf(allowed)) === "interested" && api.of("answerCallbackQuery").length === 2, [777]);
    expect(await statusOf(blocked)).toBeNull();
    expect(api.of("editMessageText")).toHaveLength(1);
  });

  it("stars a job from the second button row: the keyboard stays and flips, the status is untouched, a second press is idempotent, and ☆ takes it back", async () => {
    const id = await seedJob({ title: "Star Me", rank: 88, match: 80, bonus: 8, tiers: ["T2"] });
    const starred = async () => (await getFavorite(db(), id)) !== null;
    await poll([callback(id, "f"), callback(id, "f")], async () => api.of("answerCallbackQuery").length === 2);

    expect(await starred()).toBe(true);
    expect(await statusOf(id)).toBeNull();
    expect(await db().select().from(schema.applicationEvents)).toHaveLength(0);
    expect(api.of("answerCallbackQuery").map((x) => x.body.text)).toEqual(["⭐ 已收藏", "已经在收藏里"]);
    const edit = api.of("editMessageText")[0]?.body;
    expect(String(edit?.text).endsWith("\n\n⭐ 已收藏")).toBe(true);
    const keyboard = (edit?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([["👍 感兴趣", "🚫 忽略"], ["☆ 取消收藏"]]); // no résumé button: this test config has no resume-kit path
    expect(keyboard[1]?.[0]?.callback_data).toBe(`a:${id}:u`);

    api.reset();
    await poll([callback(id, "u")], async () => api.of("editMessageText").length >= 1 && !(await starred()));
    expect(api.of("answerCallbackQuery").at(-1)?.body.text).toBe("已取消收藏");
    const back = api.of("editMessageText").at(-1)?.body;
    expect(String(back?.text)).not.toContain("已收藏");
    expect((back?.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[1]?.[0]?.text).toBe("⭐ 收藏");
  });

  it("a status press on a starred job keeps saying it is starred and still removes the buttons", async () => {
    const id = await seedJob({ title: "Star Then Interested", rank: 88 });
    await addFavorite(db(), id);
    await poll([callback(id, "i")], async () => (await statusOf(id)) === "interested" && api.of("editMessageText").length === 1);
    const edit = api.of("editMessageText")[0]?.body;
    expect(String(edit?.text).endsWith("\n\n👍 已标记：感兴趣\n⭐ 已收藏")).toBe(true);
    expect(edit).toMatchObject({ reply_markup: { inline_keyboard: [] } });
    // the star is independent of the status
    expect(await getFavorite(db(), id)).not.toBeNull();
  });

  it("handles ignore and resume, is idempotent, and never undoes progress made elsewhere", async () => {
    const a = await seedJob({ title: "Ignore Me", rank: 80 });
    const b = await seedJob({ title: "Prepare Me", rank: 80 });
    const c = await seedJob({ title: "Already Applied", rank: 80 });
    await setApplicationStatus(db(), c, "applied");

    await poll([callback(a, "x"), callback(b, "r"), callback(b, "r"), callback(c, "i")], async () => api.of("answerCallbackQuery").length === 4);

    expect(await statusOf(a)).toBe("archived");
    expect(await statusOf(b)).toBe("preparing");
    expect(await statusOf(c)).toBe("applied");
    const answers = api.of("answerCallbackQuery").map((x) => x.body.text);
    expect(answers).toEqual(["🚫 已标记：忽略", "📄 已标记：准备中（定制简历）", "已经是「准备中」", "当前状态是「已申请」，没有改动"]);
    // the second press of the same button did not add a timeline entry
    const events = await db().select().from(schema.applicationEvents);
    expect(events.filter((e) => e.toStatus === "preparing")).toHaveLength(1);
    // the rejected press did not touch the message
    expect(api.of("editMessageText")).toHaveLength(3);
  });

  it("ignores unknown chats entirely: no database change, no reply, nothing logged from the message", async () => {
    const id = await seedJob({ title: "Private Role", rank: 80 });
    const stranger = 999;
    const foreignText: TelegramUpdate = { update_id: 77, message: { message_id: 1, chat: { id: stranger }, from: { id: stranger }, text: "super-secret-text-4711" } };
    const sentinel = callback(id, "x", Number(CHAT), 78); // ours, so the poller has something to wait for
    await poll([callback(id, "i", stranger, 76), foreignText, sentinel], async () => (await statusOf(id)) === "archived");

    // the foreign press (👍) did not mark the job; only our own press (🚫) did
    const events = await db().select().from(schema.applicationEvents);
    expect(events.map((e) => e.toStatus)).toEqual(["archived"]);
    expect(api.of("answerCallbackQuery")).toHaveLength(1);
    expect(api.of("editMessageText")).toHaveLength(1);
    expect(api.of("sendMessage")).toEqual([]);

    const joined = logs.join("\n");
    expect(joined).toContain("ignored a callback from a foreign chat");
    expect(joined).toContain("ignored a message from a foreign chat");
    expect(joined).not.toContain("super-secret-text-4711");
    expect(joined).not.toContain("a:" + id + ":i");
    expect(joined).not.toContain(FAKE_TOKEN);
  });

  it("drops garbage callback data and answers a press on a vanished job", async () => {
    const garbage: TelegramUpdate = { update_id: 90, callback_query: { id: "cq-90", from: { id: 555 }, message: { message_id: 5, chat: { id: 555 } }, data: "a:1:i; drop table jobs" } };
    await poll([garbage, callback(424242, "i", 555, 91)], async () => api.of("answerCallbackQuery").length === 2);
    expect(api.of("answerCallbackQuery").map((x) => x.body.text)).toEqual(["未知操作", "这个岗位已经不存在了"]);
    expect(await db().select().from(schema.applications)).toEqual([]);
    expect(api.of("editMessageText")).toEqual([]);
  });

  it("answers the press even when the message can no longer be edited", async () => {
    const id = await seedJob({ title: "Old Message", rank: 80 });
    api.failNext("editMessageText", 400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
    await poll([callback(id, "i")], async () => (await statusOf(id)) === "interested" && api.of("editMessageText").length === 1);
    expect(api.of("answerCallbackQuery")).toHaveLength(1);
    expect(logs.join("\n")).toContain("could not edit the message");
  });
});

// ---------------------------------------------------------------- reminders

describe("daily reminder", () => {
  const NOW = new Date("2026-10-07T07:30:00Z"); // 09:30 in Berlin
  const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);

  function deps(notify: NotifyConfig, now: Date): NotifyDeps {
    return { db: db(), client: client(), chatId: CHAT, config: notify, timeZone: "Europe/Berlin", now: () => now, logger: quietLogger, sleep: async () => {} };
  }

  async function seedApplication(title: string, status: ApplicationStatus, since: Date): Promise<number> {
    const id = await seedJob({ title, rank: 80 });
    await db().insert(schema.applications).values({ jobId: id, status, statusChangedAt: since });
    return id;
  }

  it("sends one summary of stale 'interested' and 'applied' applications per day", async () => {
    const stale = await seedApplication("Stale Interest", "interested", ago(10));
    await seedApplication("Fresh Interest", "interested", ago(2));
    await seedApplication("Silent Application", "applied", ago(20));
    await seedApplication("Recent Application", "applied", ago(5));
    await seedApplication("Done Deal", "offer", ago(90));
    const notify = config((c) => (c.public_base_url = "https://radar.example-tailnet.ts.net"));

    expect(await runReminders(deps(notify, NOW))).toBe("sent");
    const [text] = texts();
    expect(text).toContain("<b>👍 感兴趣超过 7 天还没申请</b>（1）");
    expect(text).toContain(`<a href="https://radar.example-tailnet.ts.net/jobs/${stale}">Stale Interest</a> — Acme GmbH（10 天）`);
    expect(text).toContain("<b>📨 已申请超过 14 天没有回音</b>（1）");
    expect(text).toContain("Silent Application");
    expect(text).not.toMatch(/Fresh Interest|Recent Application|Done Deal/);
    expect(texts()).toHaveLength(1);

    // the same day: nothing more; the next day: again
    expect(await runReminders(deps(notify, new Date(NOW.getTime() + 6 * HOUR)))).toBe("not_due");
    expect(await runReminders(deps(notify, new Date(NOW.getTime() + DAY)))).toBe("sent");
    expect(texts()).toHaveLength(2);
  });

  it("waits for the configured send time and for quiet hours to end", async () => {
    await seedApplication("Stale Interest", "interested", ago(10));
    const notify = config((c) => Object.assign(c.reminders as object, { send_at: "09:00" }));
    expect(await runReminders(deps(notify, new Date("2026-10-07T06:59:00Z")))).toBe("not_due"); // 08:59 Berlin
    expect(api.calls).toEqual([]);

    const quiet = config((c) => Object.assign(c.quiet_hours, { enabled: true, start: "09:00", end: "10:00" }));
    expect(await runReminders(deps(quiet, NOW))).toBe("quiet");
    expect(api.calls).toEqual([]);
    expect(await runReminders(deps(notify, NOW))).toBe("sent");
  });

  it("sends nothing on a day with nothing due, and does not look again that day", async () => {
    await seedApplication("Fresh Interest", "interested", ago(1));
    const notify = config();
    expect(await runReminders(deps(notify, NOW))).toBe("empty");
    expect(api.calls).toEqual([]);
    expect(await notificationKinds()).toEqual(["reminder"]);
    // a job that turns stale later the same day is picked up the next day
    await db().update(schema.applications).set({ statusChangedAt: ago(30) });
    expect(await runReminders(deps(notify, new Date(NOW.getTime() + HOUR)))).toBe("not_due");
    expect(await runReminders(deps(notify, new Date(NOW.getTime() + DAY)))).toBe("sent");
  });

  it("is off when reminders.enabled is false, and retries after a failed send", async () => {
    await seedApplication("Stale Interest", "interested", ago(10));
    expect(await runReminders(deps(config((c) => Object.assign(c.reminders as object, { enabled: false })), NOW))).toBe("disabled");

    api.failNext("sendMessage", 500, { ok: false, error_code: 500, description: "down" }, 1);
    expect(await runReminders(deps(config(), NOW))).toBe("failed");
    expect(await notificationKinds()).toEqual([]);
    expect(await runReminders(deps(config(), NOW))).toBe("sent");
  });
});
