import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { AiProviderError } from "@/lib/ai/errors";
import { createDbHealthStore, listProviderHealth } from "@/lib/ai/health";
import { createDbQuotaStore, quotaStateKey } from "@/lib/ai/quota-guard";
import { createAiRouter } from "@/lib/ai/router";
import { createDbUsageStore } from "@/lib/ai/usage";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, createConnection, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { aiUsageStats, countAiUsageSince, insertAiUsage, listAiUsageTimesSince } from "@/lib/db/repos/ai-usage";
import { ALERT_KIND_PREFIX } from "@/lib/db/repos/notifications";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";
import type { NotifyConfig } from "@/lib/config";
import { createNotifyStep } from "@/lib/notify/step";
import { createTelegramClient } from "@/lib/notify/telegram-client";

import { pinnedAi, scriptedProvider, shippedCatalog } from "../ai/helpers";
import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { FakeBotApi, FAKE_TOKEN } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";

const url = inject("testDatabaseUrl");
const MIN = 60_000;
const db = () => getDb();
const api = new FakeBotApi();

const reset = () => db().execute(sql`truncate table ai_usage, runtime_state, notifications, cycles, jobs, companies restart identity cascade`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  await api.start();
});

beforeEach(async () => {
  await reset();
  api.reset();
  resetCycleSteps();
});

afterAll(async () => {
  resetCycleSteps();
  await api.stop();
  await reset(); // other integration files expect empty tables
  await closeDb();
});

const call = (provider: string, at: Date) => insertAiUsage(db(), { provider, task: "score", tokensIn: 1, tokensOut: 1, costEstimate: 0, at });

describe("usage statistics (read only)", () => {
  it("measures the calls per rolling window and per cycle, per provider", async () => {
    const t0 = new Date("2026-09-01T06:00:00Z");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
    await db().insert(schema.cycles).values([
      { kind: "weekday_morning", startedAt: at(0) },
      { kind: "weekday_evening", startedAt: at(12 * 60) },
      { kind: "weekday_morning", startedAt: at(24 * 60) },
    ]);
    // cycle 1: 4 codex calls within 30 min; cycle 2: 2 codex calls; cycle 3: 1 codex call, 3 claude calls
    for (const m of [0, 10, 20, 30]) await call("codex-cli", at(m));
    for (const m of [12 * 60, 12 * 60 + 5]) await call("codex-cli", at(m));
    await call("codex-cli", at(24 * 60));
    for (const m of [24 * 60 + 1, 24 * 60 + 2, 24 * 60 + 3]) await call("claude-cli", at(m));
    await call("anthropic", at(5)); // not asked for

    const stats = await aiUsageStats(db(), { providers: ["codex-cli", "claude-cli", "mimo"], windowHours: 5 });
    const codex = stats.find((s) => s.provider === "codex-cli");
    expect(codex).toMatchObject({ calls: 7, firstAt: at(0), lastAt: at(24 * 60) });
    expect(codex?.window).toMatchObject({ samples: 7, max: 4 }); // the 4th call of cycle 1 sees 4 calls in its window
    expect(codex?.cycle).toMatchObject({ samples: 3, max: 4, p50: 2 });
    expect(stats.find((s) => s.provider === "claude-cli")?.cycle).toMatchObject({ samples: 1, max: 3 });
    expect(stats.find((s) => s.provider === "mimo")).toMatchObject({ calls: 0, window: { samples: 0, max: null }, cycle: { samples: 0, max: null } });

    expect(await countAiUsageSince(db(), { provider: "codex-cli", since: at(12 * 60) })).toBe(3);
    expect((await listAiUsageTimesSince(db(), { provider: "codex-cli", since: at(12 * 60) })).map((d) => d.getTime())).toEqual([at(12 * 60), at(12 * 60 + 5), at(24 * 60)].map((d) => d.getTime()));
  });

  it("a read-only connection refuses writes", async () => {
    const { sql: client, db: readOnly } = createConnection(url, { max: 1, readOnly: true });
    try {
      expect(await aiUsageStats(readOnly, { providers: ["codex-cli"], windowHours: 5 })).toHaveLength(1);
      await expect(readOnly.insert(schema.aiUsage).values({ provider: "codex-cli", task: "score", tokensIn: 1, tokensOut: 1, costEstimate: 0 })).rejects.toThrow();
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("the usage cap on the database", () => {
  const config = pinnedAi((raw) => {
    raw.quota_guard = { providers: { codex_cli: { hard_requests: 5, cycle_request_cap: 0 }, claude_cli: { hard_requests: 0, cycle_request_cap: 0 } } };
  });

  it("the router stores the window state in runtime_state and skips the capped provider", async () => {
    const now = new Date();
    for (let i = 0; i < 5; i += 1) await call("codex-cli", new Date(now.getTime() - (i + 1) * MIN));
    const router = createAiRouter({
      config,
      providers: [scriptedProvider("codex-cli", ['{"ok":true}']).provider, scriptedProvider("claude-cli", ['{"ok":true}']).provider],
      usage: createDbUsageStore(db()),
      quota: createDbQuotaStore(db()),
      now: () => now,
      timeZone: "UTC",
      catalog: shippedCatalog(),
    });
    expect((await router.run("score", { system: "s", user: "u" }, z.object({ ok: z.boolean() }))).provider).toBe("claude-cli");
    expect((await getRuntimeState(db(), quotaStateKey("codex-cli")))?.value).toMatchObject({ level: "hard", reason: "window", notifiedLevel: null });
  });

  it("the router and the alerts each write only their own fields (no lost update from a stale read)", async () => {
    const store = createDbQuotaStore(db());
    const now = new Date();
    await store.setNotifiedLevel("codex-cli", "hard", now);
    // the router's copy was read before the alert was recorded
    await store.setState("codex-cli", { level: "hard", reason: "window", since: now, resumeAt: now, hardRequests: 5, notifiedLevel: null });
    expect(await store.getState("codex-cli")).toMatchObject({ level: "hard", hardRequests: 5, notifiedLevel: "hard" });
    await store.setNotifiedLevel("codex-cli", "ok", now);
    expect(await store.getState("codex-cli")).toMatchObject({ level: "hard", reason: "window", hardRequests: 5, notifiedLevel: "ok" });
  });

  it("reads a broken state row as no state", async () => {
    await setRuntimeState(db(), quotaStateKey("codex-cli"), { level: 42 });
    expect(await createDbQuotaStore(db()).getState("codex-cli")).toBeNull();
  });
});

// ---------------------------------------------------------------- alerts and the push footer

const CHAT = "555";
const client = () => createTelegramClient({ token: FAKE_TOKEN, baseUrl: api.url, requestTimeoutMs: 30_000, maxRetries: 0, sleep: async () => {} });

function notify(): NotifyConfig {
  return notifyConfig((c) => {
    Object.assign(c.telegram, { enabled: true, api_base_url: api.url, message_gap_ms: 0, max_retries: 0, poll_timeout_seconds: 1 });
    Object.assign(c.quiet_hours, { enabled: false });
  });
}

const aiConfig = (notifyRecovery = true) =>
  pinnedAi((raw) => {
    raw.quota_guard = {
      notify_recovery: notifyRecovery,
      alert_dedupe_hours: 6,
      providers: { codex_cli: { hard_requests: 5, cycle_request_cap: 0 }, claude_cli: { hard_requests: 0, cycle_request_cap: 0 } },
    };
  });

function useSteps(options: { ai?: unknown; notifyRecovery?: boolean } = {}): void {
  if (options.ai !== undefined) registerCycleStep("ai", async () => ({ result: options.ai }));
  registerCycleStep(
    "notify",
    createNotifyStep({
      loadNotifyConfig: notify,
      loadAiConfig: () => aiConfig(options.notifyRecovery ?? true),
      createRuntime: () => ({ client: client(), chatId: CHAT }),
      sleep: async () => {},
    }),
  );
}

const cycle = () => runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, sleep: async () => {} });
const texts = () => api.of("sendMessage").map((c) => String(c.body.text ?? ""));
const quotaAlerts = () => texts().filter((t) => t.startsWith("🚨"));
const capCodex = async () => {
  for (let i = 0; i < 5; i += 1) await call("codex-cli", new Date(Date.now() - (i + 1) * MIN));
};

describe("usage-cap alerts", () => {
  it("alert once when the cap starts, never again while it lasts (even past the anti-flap window), once on recovery", async () => {
    await capCodex();
    useSteps();
    await cycle();
    expect(quotaAlerts()).toHaveLength(1);
    expect(quotaAlerts()[0]).toContain("codex-cli");
    expect((await getRuntimeState(db(), quotaStateKey("codex-cli")))?.value).toMatchObject({ notifiedLevel: "hard" });

    // still capped, the earlier alert row is gone (as if the anti-flap window had passed): nothing new
    await db().delete(schema.notifications);
    api.reset();
    await cycle();
    expect(quotaAlerts()).toEqual([]);

    // the calls are gone: one recovery message, then nothing
    await db().execute(sql`truncate table ai_usage`);
    api.reset();
    await cycle();
    expect(quotaAlerts()).toHaveLength(1);
    expect(quotaAlerts()[0]).toContain("codex-cli");
    api.reset();
    await cycle();
    expect(quotaAlerts()).toEqual([]);
    const kinds = (await db().select().from(schema.notifications)).map((n) => n.kind).filter((k) => k.startsWith(ALERT_KIND_PREFIX));
    expect(kinds).toEqual([`${ALERT_KIND_PREFIX}quota_recovered`]);
  });

  it("a provider that reports `limit reached|<epoch>` cools down until then, and the alerts say so exactly once", async () => {
    const until = Math.floor(Date.now() / 1000) + 2 * 3600;
    const claude = scriptedProvider("claude-cli", [new AiProviderError("claude-cli", "rate_limited", `Claude AI usage limit reached|${until}`)]);
    const router = createAiRouter({ config: aiConfig(), providers: [claude.provider], usage: createDbUsageStore(db()), health: createDbHealthStore(db()), quota: createDbQuotaStore(db()), timeZone: "UTC", catalog: shippedCatalog() });
    await expect(router.run("score", { system: "s", user: "u" }, z.object({ ok: z.boolean() }))).rejects.toThrow();
    expect((await listProviderHealth(db())).get("claude-cli")?.coolingUntil).toEqual(new Date(until * 1000));

    useSteps();
    await cycle();
    await cycle();
    expect(quotaAlerts()).toHaveLength(1);
    expect(quotaAlerts()[0]).toContain("claude-cli");
    const kinds = (await db().select().from(schema.notifications)).map((n) => n.kind).filter((k) => k.startsWith(ALERT_KIND_PREFIX));
    expect(kinds).toEqual([`${ALERT_KIND_PREFIX}quota_cooldown`]);
  });

  it("with notify_recovery off the recovery is only recorded, so the next cap alerts again", async () => {
    await capCodex();
    useSteps({ notifyRecovery: false });
    await cycle();
    await db().execute(sql`truncate table ai_usage`);
    api.reset();
    await cycle();
    expect(quotaAlerts()).toEqual([]);
    expect((await getRuntimeState(db(), quotaStateKey("codex-cli")))?.value).toMatchObject({ notifiedLevel: "ok" });
  });
});

describe("push footer", () => {
  async function seedUnscored(count: number): Promise<void> {
    await db().insert(schema.companies).values({ name: "Acme GmbH", nameNorm: "acme-gmbh" });
    const [company] = await db().select().from(schema.companies).where(eq(schema.companies.nameNorm, "acme-gmbh"));
    for (let i = 0; i < count; i += 1) {
      const [job] = await db()
        .insert(schema.jobs)
        .values({
          companyId: company!.id,
          title: `Waiting Engineer ${i}`,
          titleNorm: `waiting engineer ${i}`,
          locationsJson: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: true }],
          workplace: "hybrid",
          germanLevelRequired: "none",
          firstSeenAt: new Date(Date.now() + 60_000),
        })
        .returning();
      await withRebuiltCurrentScores(db(), db().insert(schema.scores).values({ jobId: job!.id, filterResult: "passed", score: null, signalBonus: 0, rankValue: null }));
    }
  }

  it("names the new jobs the cap left unscored as the summary's last line", async () => {
    await seedUnscored(2);
    useSteps({ ai: { subtasks: [], skipped: "quota_guard", resumeAt: null } });
    await cycle();
    const summary = texts().find((t) => t.startsWith("<b>📡"));
    expect(summary?.split("\n").at(-1)).toBe("另有 2 个新岗位因 AI 用量上限暂未打分，下一轮处理。");
  });

  it("counts only the jobs the cap held back, not the ones per_cycle_limit left for later", async () => {
    await seedUnscored(3);
    const [first] = await db().select({ id: schema.jobs.id }).from(schema.jobs).orderBy(schema.jobs.id).limit(1);
    useSteps({ ai: { subtasks: [{ name: "score", status: "ok", result: { scored: 1, stopped: "quota_guard", quotaResumeAt: null, quotaHeldJobIds: [first!.id] } }] } });
    await cycle();
    const summary = texts().find((t) => t.startsWith("<b>📡"));
    expect(summary?.split("\n").at(-1)).toBe("另有 1 个新岗位因 AI 用量上限暂未打分，下一轮处理。");
  });

  it("has no such line when the cap played no part or nothing waits", async () => {
    await seedUnscored(2);
    useSteps({ ai: { subtasks: [{ name: "score", status: "ok", result: { scored: 0 } }] } });
    await cycle();
    expect(texts().join("\n")).not.toContain("AI 用量上限");

    await reset();
    api.reset();
    resetCycleSteps();
    useSteps({ ai: { subtasks: [], skipped: "quota_guard", resumeAt: null } });
    await cycle();
    expect(texts().join("\n")).not.toContain("AI 用量上限");
  });
});
