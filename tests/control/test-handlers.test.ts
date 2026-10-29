// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMemoryHealthStore } from "@/lib/ai/health";
import { createMemoryQuotaStore } from "@/lib/ai/quota-guard";
import { createMemoryUsageStore } from "@/lib/ai/usage";
import { ChannelError } from "@/lib/channels/errors";
import { NO_DELIVERIES } from "@/lib/channels/delivery";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { createMemoryStateStore } from "@/lib/channels/store";
import { createTestAiHandler } from "@/lib/control/test-ai";
import { createTestChannelHandler, TEST_SAMPLE_TITLES } from "@/lib/control/test-channel";
import { createTestTelegramHandler } from "@/lib/control/test-telegram";
import type { ControlHandlerContext } from "@/lib/control/types";
import type { Db } from "@/lib/db/client";
import type { ControlRequest } from "@/lib/db/repos/control-requests";
import { createTelegramRuntime } from "@/lib/notify/runtime";

import { scriptedProvider, pinnedAi, usageEntry } from "../ai/helpers";
import { quietLogger, config as cycleConfig } from "../cycle/helpers";
import { FAKE_TOKEN, FakeBotApi } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";

const db = {} as Db;
const context = (signal = new AbortController().signal): ControlHandlerContext => ({ db, signal, logger: quietLogger });
const request = (kind: ControlRequest["kind"], payload: unknown): ControlRequest => ({
  id: 1,
  kind,
  payload,
  status: "running",
  result: null,
  requestedAt: new Date(),
  startedAt: new Date(),
  finishedAt: null,
});

describe("test_channel", () => {
  const base = () => ({ config: cycleConfig(), cycleRunning: async () => false, budgetStore: () => createMemoryStateStore(null), sleep: async () => {} });

  it("fetches one small query in memory and reports counts and the first titles", async () => {
    const registry = new ChannelRegistry();
    const channel = registerFixtureChannel(registry, { id: "arbeitsagentur" });
    const outcome = await createTestChannelHandler({ ...base(), registry })(request("test_channel", { channelId: "arbeitsagentur" }), context());
    expect(outcome.status).toBe("done");
    // only the first query of the plan, capped at sources.yaml test_channel.max_results
    expect(channel.seen).toHaveLength(1);
    expect(channel.seen[0]?.maxResults).toBe(cycleConfig().channels.test_channel.max_results);
    expect(outcome.result).toMatchObject({ channelId: "arbeitsagentur", fetched: 5, parsed: 5, parseFailed: 0 });
    expect(outcome.result.sampleTitles).toHaveLength(TEST_SAMPLE_TITLES);
  });

  it("refuses an unknown, excluded, disabled or unconfigured channel, and while a cycle runs", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "linkedin-brightdata", kind: "paid" });
    registerFixtureChannel(registry, { id: "indeed", settings: { enabled: false } });
    const unconfigured = registerFixtureChannel(registry, { id: "jsearch" });
    Object.assign(unconfigured, { isConfigured: () => false });
    registerFixtureChannel(registry, { id: "arbeitsagentur" });
    const handler = createTestChannelHandler({ ...base(), registry });
    const run = async (channelId: string) => (await handler(request("test_channel", { channelId }), context())).result.error;
    expect(await run("stepstone")).toBe("unknown_channel");
    expect(await run("linkedin-brightdata")).toBe("channel_excluded");
    expect(await run("indeed")).toBe("channel_disabled");
    expect(await run("jsearch")).toBe("not_configured");
    expect((await handler(request("test_channel", { channelId: "../x", extra: 1 }), context())).result.error).toBe("invalid_payload");

    const busy = createTestChannelHandler({ ...base(), registry, cycleRunning: async () => true });
    expect((await busy(request("test_channel", { channelId: "arbeitsagentur" }), context())).result.error).toBe("another_cycle_running");
  });

  it("gives channel tests a no-op delivery recorder without touching the database", async () => {
    const registry = new ChannelRegistry();
    const channel = registerFixtureChannel(registry, { id: "arbeitsagentur" });
    channel.collect = async (_query, ctx) => {
      expect(ctx.deliveries).toBe(NO_DELIVERIES);
      expect(ctx.deliveries.received({ batch: ctx.deliveries.beginBatch(), items: [{ id: "test-receipt" }] })).toEqual([]);
      return [];
    };
    const outcome = await createTestChannelHandler({ ...base(), registry })(request("test_channel", { channelId: "arbeitsagentur" }), context());
    expect(outcome).toMatchObject({ status: "done", result: { fetched: 0 } });
  });

  it("refuses a paid channel with no budget left (when not excluded)", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "arbeitsagentur", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 0 } });
    const outcome = await createTestChannelHandler({ ...base(), registry })(request("test_channel", { channelId: "arbeitsagentur" }), context());
    expect(outcome.result.error).toBe("budget_exceeded");
  });

  it("reports a failing channel by its error class only", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "arbeitsagentur", failure: { code: "blocked" } });
    const outcome = await createTestChannelHandler({ ...base(), registry })(request("test_channel", { channelId: "arbeitsagentur" }), context());
    expect(outcome).toMatchObject({ status: "failed", result: { error: "channel_test_failed", errorCode: "blocked" } });
    expect(JSON.stringify(outcome.result)).not.toContain("simulated");
  });

  it("lets a board-discovery channel (tavily) send at most test_channel.max_queries searches", async () => {
    const registry = new ChannelRegistry();
    const channel = registerFixtureChannel(registry, { id: "tavily", usesQueries: false, settings: { extra: { max_queries_per_run: 6, interval_hours: 24 } } });
    let seen: unknown = null;
    Object.assign(channel, {
      collect: async (_query: unknown, ctx: { settings: { extra: Record<string, unknown> } }) => {
        seen = ctx.settings.extra.max_queries_per_run;
        return [];
      },
    });
    const outcome = await createTestChannelHandler({ ...base(), registry })(request("test_channel", { channelId: "tavily" }), context());
    expect(outcome).toMatchObject({ status: "done", result: { channelId: "tavily", fetched: 0 } });
    expect(seen).toBe(cycleConfig().channels.test_channel.max_queries);
  });

  it("gives up after test_channel.timeout_seconds", async () => {
    const registry = new ChannelRegistry();
    const channel = registerFixtureChannel(registry, { id: "arbeitsagentur" });
    Object.assign(channel, {
      collect: (_query: unknown, ctx: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new ChannelError("network", "aborted")))),
    });
    const config = cycleConfig();
    const handler = createTestChannelHandler({ ...base(), registry, config: { ...config, channels: { ...config.channels, test_channel: { ...config.channels.test_channel, timeout_seconds: 0.05 } } } });
    const outcome = await handler(request("test_channel", { channelId: "arbeitsagentur" }), context());
    expect(outcome.result).toMatchObject({ error: "channel_test_failed", errorCode: "timeout" });
  });
});

describe("test_ai", () => {
  it("sends one probe through the router to exactly that provider and records it as a probe", async () => {
    const usage = createMemoryUsageStore();
    const health = createMemoryHealthStore();
    const claude = scriptedProvider("claude-cli", ['{"answer":"ok"}']);
    const codex = scriptedProvider("codex-cli", ['{"answer":"ok"}']);
    const handler = createTestAiHandler({ config: pinnedAi(), timeZone: "Europe/Berlin", providers: () => [claude.provider, codex.provider], usage: () => usage, health: () => health });
    const outcome = await handler(request("test_ai", { provider: "claude-cli" }), context());
    expect(outcome).toMatchObject({ status: "done", result: { provider: "claude-cli", model: "claude-cli-model", tokensIn: 100, tokensOut: 10 } });
    expect(claude.transport.calls).toHaveLength(1);
    expect(codex.transport.calls).toHaveLength(0);
    expect(usage.entries.map((e) => e.task)).toEqual(["probe"]);
    expect(health.rows.get("claude-cli")?.requestsToday).toBe(1);
  });

  it("reports a provider the router may not try (switched off) without calling it, and a failing one by kind", async () => {
    const off = scriptedProvider("deepseek", ['{"answer":"ok"}']);
    const handler = createTestAiHandler({
      config: pinnedAi((raw) => {
        (raw.providers as { deepseek: { enabled: boolean } }).deepseek.enabled = false;
      }),
      timeZone: "UTC",
      providers: () => [off.provider],
      usage: () => createMemoryUsageStore(),
      health: () => createMemoryHealthStore(),
    });
    expect((await handler(request("test_ai", { provider: "deepseek" }), context())).result).toMatchObject({ error: "ai_unavailable", errorKind: "not_configured" });
    expect(off.transport.calls).toHaveLength(0);

    const broken = scriptedProvider("mimo", ["not json at all"]);
    const failing = createTestAiHandler({ config: pinnedAi(), timeZone: "UTC", providers: () => [broken.provider], usage: () => createMemoryUsageStore(), health: () => createMemoryHealthStore() });
    const outcome = await failing(request("test_ai", { provider: "mimo" }), context());
    expect(outcome).toMatchObject({ status: "failed", result: { error: "ai_test_failed", errorKind: "invalid_output" } });
    expect((await failing(request("test_ai", { provider: "gpt" }), context())).result.error).toBe("invalid_payload");
  });
});

describe("test_ai: Job Radar's usage cap", () => {
  it("does not call a CLI whose window is full and reports the code with the expected time", async () => {
    const now = new Date("2026-10-07T10:00:00Z");
    const codex = scriptedProvider("codex-cli", ['{"answer":"ok"}']);
    const calls = [1, 2].map((m) => usageEntry({ provider: "codex-cli", task: "score", at: new Date(now.getTime() - m * 60_000) }));
    const handler = createTestAiHandler({
      config: pinnedAi((raw) => {
        raw.quota_guard = { providers: { codex_cli: { hard_requests: 2, cycle_request_cap: 1 } } };
      }),
      timeZone: "UTC",
      providers: () => [codex.provider],
      usage: () => createMemoryUsageStore(),
      health: () => createMemoryHealthStore(),
      quota: () => createMemoryQuotaStore(calls),
      now: () => now,
    });
    const outcome = await handler(request("test_ai", { provider: "codex-cli" }), context());
    expect(outcome).toMatchObject({ status: "failed", result: { error: "quota_guard", provider: "codex-cli", resumeAt: expect.any(String) } });
    expect(codex.transport.calls).toHaveLength(0);
  });
});

describe("test_telegram", () => {
  const api = new FakeBotApi();
  beforeAll(() => api.start());
  afterAll(() => api.stop());
  beforeEach(() => api.reset());

  const handlerWith = (env: Record<string, string>) =>
    createTestTelegramHandler({
      config: notifyConfig((raw) => {
        raw.telegram.enabled = false;
      }),
      runtime: (config, signal) => createTelegramRuntime({ config: { ...config, telegram: { ...config.telegram, api_base_url: api.url } }, logger: quietLogger, env: { ...env, JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" }, signal }),
    });

  it("sends the test message even while pushes are off", async () => {
    const outcome = await handlerWith({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: "42" })(request("test_telegram", {}), context());
    expect(outcome.status).toBe("done");
    expect(api.of("sendMessage")).toHaveLength(1);
    expect(JSON.stringify(outcome.result)).not.toContain(FAKE_TOKEN);
  });

  it("says when the credentials are missing, and reports a refusal by kind only", async () => {
    expect((await handlerWith({})(request("test_telegram", {}), context())).result).toEqual({ error: "telegram_not_configured" });
    api.failNext("sendMessage", 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
    const outcome = await handlerWith({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: "42" })(request("test_telegram", {}), context());
    expect(outcome).toMatchObject({ status: "failed", result: { error: "telegram_failed", errorKind: "api", httpStatus: 400 } });
    expect(JSON.stringify(outcome.result)).not.toContain("chat not found");
  });
});
