import { describe, expect, it } from "vitest";

import type { ChannelCycleStat, ChannelStateRow, CycleChannelRuns, LatestCycleRuns, RecentRun } from "@/lib/db/queries/sources";
import { buildChannelHistory, buildSourcesView, channelStatus, cycleOutcome, type SourcesViewInput } from "@/lib/sources/view";

import { pinnedAi, shippedCatalog } from "../ai/helpers";
import { shippedChannels } from "../channels/helpers";

const NOW = new Date("2026-10-07T12:00:00Z");

function state(id: string, extra: Partial<ChannelStateRow> = {}): ChannelStateRow {
  return {
    id,
    family: id.startsWith("linkedin") ? "linkedin" : id,
    kind: "api",
    health: "healthy",
    circuitState: "closed",
    circuitOpenUntil: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastSuccessAt: null,
    ...extra,
  };
}

function cycleChannel(channelId: string, extra: Partial<CycleChannelRuns> = {}): CycleChannelRuns {
  return { channelId, family: "linkedin", runs: 1, succeeded: 1, failed: 0, skipped: 0, fetched: 10, ...extra };
}

function input(extra: Partial<SourcesViewInput> = {}): SourcesViewInput {
  return {
    now: NOW,
    month: "2026-10",
    channelsConfig: shippedChannels(),
    aiConfig: { monthly_api_budget_usd: 10 },
    states: [],
    runsByChannel: new Map(),
    usage: new Map(),
    runTotals: new Map(),
    latestCycle: null,
    aiRows: [],
    apiSpendUsd: 0,
    lastHeartbeatAt: null,
    heartbeatIntervalSeconds: 30,
    heartbeatStaleFactor: 3,
    aiWorker: { execution: "host", online: false, lastHeartbeatAt: null, ageSeconds: null, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun: null },
    ...extra,
  };
}

describe("buildSourcesView", () => {
  it("lists every configured channel, the LinkedIn cascade first and in cascade order", () => {
    const config = shippedChannels();
    const reordered = { ...config, linkedin: { ...config.linkedin, cascade: ["linkedin-guest", "linkedin-brightdata"] as typeof config.linkedin.cascade } };
    const view = buildSourcesView(input({ channelsConfig: reordered }));
    expect(view.cards.slice(0, 2).map((c) => c.id)).toEqual(["linkedin-guest", "linkedin-brightdata"]);
    expect(view.cards.map((c) => c.id)).toContain("jobspy-google");
    expect(new Set(view.cards.map((c) => c.id)).size).toBe(view.cards.length);
    expect(view.cascade.entries.map((e) => [e.id, e.position])).toEqual([
      ["linkedin-guest", 1],
      ["linkedin-brightdata", 2],
    ]);
  });

  it("flags channels without a row as not implemented and takes the switch from sources.yaml", () => {
    const view = buildSourcesView(input({ states: [state("indeed"), state("linkedin-guest")] }));
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    expect(byId.get("indeed")).toMatchObject({ registered: true, enabled: true });
    expect(byId.get("jsearch")).toMatchObject({ registered: false, enabled: false, circuit: null });
    expect(byId.get("linkedin-apify")).toMatchObject({ registered: false, enabled: true });
    expect(byId.get("linkedin-session")).toMatchObject({ registered: false, enabled: false });
  });

  it("reports an open circuit as half-open once its cooldown has passed", () => {
    const open = state("indeed", { circuitState: "open", circuitOpenUntil: new Date("2026-10-07T13:00:00Z"), consecutiveFailures: 3, lastErrorCode: "blocked" });
    const cooled = state("lever", { circuitState: "open", circuitOpenUntil: new Date("2026-10-07T11:00:00Z"), consecutiveFailures: 3 });
    const view = buildSourcesView(input({ states: [open, cooled] }));
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    expect(byId.get("indeed")?.circuit).toMatchObject({ state: "open", consecutiveFailures: 3, lastErrorCode: "blocked" });
    expect(byId.get("lever")?.circuit?.state).toBe("half_open");
  });

  it("combines month usage with the configured budgets and free allowance", () => {
    const usage = new Map([
      ["linkedin-brightdata", { records: 5200, usd: 0.3 }],
      ["arbeitsagentur", { records: 40, usd: 0 }],
      ["linkedin-apify", { records: 10, usd: 1.25 }],
    ]);
    const view = buildSourcesView(input({ usage }));
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    const none = { runs: 0, fetched: 0, newCount: 0 };
    expect(byId.get("linkedin-brightdata")?.usage).toEqual({ records: 5200, usd: 0.3, budgetUsd: 5, freeRecords: 5000, activity: none });
    expect(byId.get("arbeitsagentur")?.usage).toEqual({ records: 40, usd: 0, budgetUsd: 0, freeRecords: 0, activity: none });
    expect(view.paid).toEqual({ usedUsd: 1.55, capUsd: 15 });
  });

  it("shows what free channels did this month from their runs (the budget counters stay 0 for them)", () => {
    const runTotals = new Map([
      ["lever", { runs: 12, fetched: 80, newCount: 14 }],
      ["indeed", { runs: 3, fetched: 5, newCount: 5 }],
    ]);
    const view = buildSourcesView(input({ runTotals }));
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    expect(byId.get("lever")?.usage).toMatchObject({ records: 0, budgetUsd: 0, freeRecords: 0, activity: { runs: 12, fetched: 80, newCount: 14 } });
    expect(byId.get("indeed")?.usage.activity).toEqual({ runs: 3, fetched: 5, newCount: 5 });
    expect(byId.get("greenhouse")?.usage.activity).toEqual({ runs: 0, fetched: 0, newCount: 0 });
  });

  it("finds which cascade channel served the latest cycle", () => {
    const latest: LatestCycleRuns = {
      id: 7,
      kind: "weekday_morning",
      status: "succeeded",
      startedAt: NOW,
      finishedAt: NOW,
      channels: [
        cycleChannel("linkedin-brightdata", { succeeded: 0, failed: 1, runs: 1, fetched: 0 }),
        cycleChannel("linkedin-guest", { succeeded: 3, runs: 3 }),
        cycleChannel("indeed", { family: "indeed" }),
      ],
    };
    const view = buildSourcesView(input({ latestCycle: latest }));
    expect(view.cascade.servedBy).toEqual(["linkedin-guest"]);
    expect(view.cascade.entries.find((e) => e.id === "linkedin-apify")?.latest).toBeNull();
    expect(view.cards.find((c) => c.id === "indeed")?.latestCycleRuns?.fetched).toBe(10);
  });

  it("sums AI cost, keeps the API spend and judges the runner by its heartbeat", () => {
    const rows = [
      { provider: "codex-cli", task: "score", calls: 4, tokensIn: 100, tokensOut: 20, costUsd: 0 },
      { provider: "deepseek", task: "translate", calls: 2, tokensIn: 50, tokensOut: 70, costUsd: 0.0123 },
    ];
    const fresh = buildSourcesView(input({ aiRows: rows, apiSpendUsd: 0.0123, lastHeartbeatAt: new Date(NOW.getTime() - 45_000) }));
    expect(fresh.ai).toMatchObject({ totalCostUsd: 0.0123, apiSpendUsd: 0.0123, budgetUsd: 10 });
    expect(fresh.runner).toMatchObject({ ageSeconds: 45, online: true });
    const stale = buildSourcesView(input({ lastHeartbeatAt: new Date(NOW.getTime() - 91_000) }));
    expect(stale.runner).toMatchObject({ ageSeconds: 91, online: false });
    expect(buildSourcesView(input()).runner).toMatchObject({ ageSeconds: null, online: false });
  });

  it("passes the runs through untouched", () => {
    const run: RecentRun = { id: 1, cycleId: 1, startedAt: NOW, finishedAt: NOW, status: "failed", fetched: 0, newCount: 0, cost: 0, errorCode: "blocked", error: "blocked by the site" };
    const view = buildSourcesView(input({ runsByChannel: new Map([["indeed", [run]]]) }));
    expect(view.cards.find((c) => c.id === "indeed")?.runs).toEqual([run]);
  });

  it("marks brave as not configured only when the key is known to be missing", () => {
    const flagged = (extra: Partial<SourcesViewInput>) => buildSourcesView(input(extra)).cards.filter((c) => c.notConfigured).map((c) => c.id);
    expect(flagged({ braveConfigured: false })).toEqual(["brave"]);
    expect(flagged({ braveConfigured: true })).toEqual([]);
    expect(flagged({})).toEqual([]);
  });

  it("marks tavily as not configured only when the key is known to be missing", () => {
    const flagged = (extra: Partial<SourcesViewInput>) => buildSourcesView(input(extra)).cards.filter((c) => c.notConfigured).map((c) => c.id);
    expect(flagged({ tavilyConfigured: false })).toEqual(["tavily"]);
    expect(flagged({ tavilyConfigured: true })).toEqual([]);
    expect(flagged({})).toEqual([]);
  });

  it("marks linkedin-apify as not configured (card and cascade entry) only when the token or actor id is known to be missing", () => {
    const flagged = (extra: Partial<SourcesViewInput>) => buildSourcesView(input(extra)).cards.filter((c) => c.notConfigured).map((c) => c.id);
    expect(flagged({ apifyConfigured: false })).toEqual(["linkedin-apify"]);
    expect(flagged({ apifyConfigured: true })).toEqual([]);
    expect(flagged({})).toEqual([]);
    const entries = buildSourcesView(input({ apifyConfigured: false })).cascade.entries;
    expect(entries.filter((e) => e.notConfigured).map((e) => e.id)).toEqual(["linkedin-apify"]);
  });

  it("marks linkedin-brightdata as not configured (card and cascade entry) when its key is known to be missing", () => {
    const flagged = (extra: Partial<SourcesViewInput>) => buildSourcesView(input(extra)).cards.filter((c) => c.notConfigured).map((c) => c.id);
    expect(flagged({ brightdataConfigured: false })).toEqual(["linkedin-brightdata"]);
    expect(flagged({ brightdataConfigured: true })).toEqual([]);
    expect(flagged({})).toEqual([]);
    const entries = buildSourcesView(input({ brightdataConfigured: false })).cascade.entries;
    expect(entries.filter((e) => e.notConfigured).map((e) => e.id)).toEqual(["linkedin-brightdata"]);
  });

  it("marks jsearch as not configured when JSEARCH_API_KEY is known to be missing", () => {
    const flagged = (extra: Partial<SourcesViewInput>) => buildSourcesView(input(extra)).cards.filter((c) => c.notConfigured).map((c) => c.id);
    expect(flagged({ jsearchConfigured: false })).toEqual(["jsearch"]);
    expect(flagged({ jsearchConfigured: false, braveConfigured: false }).sort()).toEqual(["brave", "jsearch"]);
    expect(flagged({ jsearchConfigured: true })).toEqual([]);
  });
});

describe("AI providers", () => {
  it("flags API providers without a key as not configured and falls back to the last recorded call for last success", () => {
    const view = buildSourcesView(
      input({
        aiConfig: pinnedAi(),
        aiConfigured: { anthropic: false, deepseek: true, mimo: false },
        aiLastUsedAt: new Map([["claude-cli", new Date("2026-10-06T10:00:00Z")]]),
      }),
    );
    const byId = Object.fromEntries(view.ai.providers.map((p) => [p.id, p]));
    expect(byId["anthropic"]?.configured).toBe(false);
    expect(byId["mimo"]?.configured).toBe(false);
    expect(byId["deepseek"]?.configured).toBe(true);
    expect(byId["claude-cli"]?.configured).toBe(true);
    expect(byId["claude-cli"]?.lastSuccessAt).toEqual(new Date("2026-10-06T10:00:00Z"));
    expect(byId["codex-cli"]?.lastSuccessAt).toBeNull();
  });

  it("names the environment variables a channel lacks, and nothing for channels that need none", () => {
    const view = buildSourcesView(input({ env: { TAVILY_API_KEY: "  ", JSEARCH_API_KEY: "x" } }));
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    expect(byId.get("tavily")?.missingEnv).toEqual(["TAVILY_API_KEY"]);
    expect(byId.get("jsearch")?.missingEnv).toEqual([]);
    expect(byId.get("linkedin-guest")?.missingEnv).toEqual([]);
    expect(buildSourcesView(input()).cards.every((c) => c.missingEnv.length === 0)).toBe(true);
  });
});

describe("test buttons and provider states", () => {
  it("offers the channel test only for registered channels whose kind is not excluded", () => {
    const view = buildSourcesView(
      input({ states: [state("arbeitsagentur"), state("linkedin-brightdata", { kind: "paid" }), state("linkedin-session", { kind: "session" }), state("indeed", { kind: "guest" })] }),
    );
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    expect(byId.get("arbeitsagentur")).toMatchObject({ kind: "api", testable: true });
    expect(byId.get("indeed")?.testable).toBe(true);
    expect(byId.get("linkedin-brightdata")?.testable).toBe(false);
    expect(byId.get("linkedin-session")?.testable).toBe(false);
    expect(byId.get("stepstone")).toMatchObject({ kind: null, testable: false });
  });

  it("gives each AI provider its state", () => {
    const view = buildSourcesView(input({ aiConfig: pinnedAi(), aiConfigured: { anthropic: false, deepseek: true, mimo: true } }));
    const byId = Object.fromEntries(view.ai.providers.map((p) => [p.id, p.state]));
    expect(byId).toMatchObject({ anthropic: "unconfigured", deepseek: "ready", "claude-cli": "ready" });
  });
});

function stat(extra: Partial<ChannelCycleStat> = {}): ChannelCycleStat {
  return { cycleId: 1, runs: 1, succeeded: 1, partial: 0, failed: 0, skipped: 0, running: 0, fetched: 10, newCount: 1, ...extra };
}

describe("the default model of each provider", () => {
  const models = (edit?: Parameters<typeof shippedCatalog>[0], ai: Parameters<typeof pinnedAi>[0] = () => {}) =>
    Object.fromEntries(
      buildSourcesView(input({ aiConfig: pinnedAi(ai), ...(edit ? { catalog: shippedCatalog(edit) } : { catalog: shippedCatalog() }) })).ai.providers.map((p) => [p.id, p.model]),
    );

  it("names the model with its catalog label; codex without a model is the CLI default", () => {
    const m = models();
    expect(m["claude-cli"]).toEqual({ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", status: "ok" });
    expect(m.deepseek).toEqual({ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", status: "ok" });
    expect(m["codex-cli"]).toEqual({ id: null, label: "GPT-6.1 Sol", status: "cliDefault" });
  });

  it("flags a deprecated model and one that is not in the catalog", () => {
    const m = models(
      (raw) => { ((raw.providers as Record<string, { models: Record<string, unknown>[] }>)["claude-cli"]!.models[0]!).deprecated = true; },
      (raw) => { (raw.providers as Record<string, Record<string, unknown>>).mimo!.model = "mimo-gone"; },
    );
    expect(m["claude-cli"]).toMatchObject({ id: "claude-haiku-4-5", status: "deprecated" });
    expect(m.mimo).toEqual({ id: "mimo-gone", label: null, status: "missing" });
  });

  it("without a catalog nothing is labelled or flagged", () => {
    const view = buildSourcesView(input({ aiConfig: pinnedAi(), catalog: null }));
    const m = Object.fromEntries(view.ai.providers.map((p) => [p.id, p.model]));
    expect(m.anthropic).toEqual({ id: "claude-haiku-4-5", label: null, status: "ok" });
    expect(m["codex-cli"]).toEqual({ id: null, label: null, status: "cliDefault" });
  });
});

describe("cycleOutcome", () => {
  it("judges a channel's cycle from its runs", () => {
    expect(cycleOutcome(stat())).toBe("ok");
    expect(cycleOutcome(stat({ runs: 3, succeeded: 2, failed: 1 }))).toBe("warn");
    expect(cycleOutcome(stat({ runs: 2, succeeded: 0, partial: 1, failed: 1 }))).toBe("warn");
    expect(cycleOutcome(stat({ runs: 1, succeeded: 0, partial: 1 }))).toBe("warn");
    expect(cycleOutcome(stat({ runs: 2, succeeded: 0, failed: 2 }))).toBe("fail");
    // skipped only (the cascade did not need it) and no run at all: nothing to judge, not "ok" and not "failed"
    expect(cycleOutcome(stat({ runs: 1, succeeded: 0, skipped: 1 }))).toBeNull();
    expect(cycleOutcome(stat({ runs: 0, succeeded: 0 }))).toBeNull();
    expect(cycleOutcome(null)).toBeNull();
  });
});

describe("buildChannelHistory", () => {
  const stats = [stat({ fetched: 5 }), null, stat({ fetched: 7, failed: 1, succeeded: 0 }), stat({ fetched: 9, running: 1, newCount: 4 })];

  it("cuts the trend and the health strip to the configured numbers, newest last", () => {
    expect(buildChannelHistory(stats, 2, 3)).toEqual({ fetched: [7, 9], outcomes: [null, "fail", "ok"], running: true, latest: { fetched: 9, newCount: 4 }, skippedStreak: 0 });
    // a gap stays a gap (null), never 0
    expect(buildChannelHistory(stats, 4, 4).fetched).toEqual([5, null, 7, 9]);
  });

  it("is empty for a channel without history", () => {
    expect(buildChannelHistory([], 7, 14)).toEqual({ fetched: [], outcomes: [], running: false, latest: null, skippedStreak: 0 });
    expect(buildChannelHistory(stats, 0, 0)).toMatchObject({ fetched: [], outcomes: [] });
    expect(buildChannelHistory([stat(), null], 2, 2).latest).toBeNull();
  });
});

describe("skipped-only cycles", () => {
  it("counts the newest cycles that only had skipped runs, ignoring cycles without a run", () => {
    const skipped = (cycleId: number) => stat({ cycleId, succeeded: 0, skipped: 1 });
    expect(buildChannelHistory([stat(), skipped(2), null, skipped(4)], 4, 4).skippedStreak).toBe(2);
    expect(buildChannelHistory([skipped(1), stat({ cycleId: 2 })], 2, 2).skippedStreak).toBe(0);
    expect(buildChannelHistory([stat({ cycleId: 1, runs: 2, succeeded: 1, skipped: 1 })], 1, 1).skippedStreak).toBe(0);
  });

  it("reads such a channel as degraded, not idle and not the old ok", () => {
    const base = { registered: true, enabled: true, needsCredentials: false, circuit: "closed" as const, health: "healthy" as const, consecutiveFailures: 0 };
    expect(channelStatus({ ...base, outcomes: [null, null], skippedStreak: 3 })).toBe("degraded");
    expect(channelStatus({ ...base, outcomes: ["ok", null, null], skippedStreak: 1 })).toBe("degraded");
    expect(channelStatus({ ...base, outcomes: ["ok"], skippedStreak: 0 })).toBe("ok");
  });
});

describe("channelStatus", () => {
  const base = { registered: true, enabled: true, needsCredentials: false, circuit: "closed" as const, health: "healthy" as const, consecutiveFailures: 0, outcomes: ["ok"] as const };

  it("puts what blocks a channel before how its cycles went", () => {
    expect(channelStatus({ ...base, registered: false })).toBe("not_registered");
    expect(channelStatus({ ...base, enabled: false })).toBe("off");
    expect(channelStatus({ ...base, needsCredentials: true })).toBe("missing_credentials");
    expect(channelStatus({ ...base, circuit: "open" })).toBe("open");
    expect(channelStatus({ ...base, circuit: "half_open" })).toBe("half_open");
  });

  it("reads the newest judged cycle, and degrades on health or failures", () => {
    expect(channelStatus(base)).toBe("ok");
    expect(channelStatus({ ...base, outcomes: ["ok", "fail"] })).toBe("failing");
    expect(channelStatus({ ...base, outcomes: ["fail", "warn", null] })).toBe("degraded");
    expect(channelStatus({ ...base, health: "degraded" })).toBe("degraded");
    expect(channelStatus({ ...base, consecutiveFailures: 2 })).toBe("degraded");
    expect(channelStatus({ ...base, outcomes: [null, null] })).toBe("idle");
  });
});

describe("buildSourcesView: history, quota and the alert line", () => {
  it("hands each card its history and status, each cascade step its quota", () => {
    const view = buildSourcesView(
      input({
        states: [state("linkedin-brightdata"), state("linkedin-guest")],
        history: new Map([["linkedin-brightdata", [stat({ fetched: 31 })]]]),
        trendCycles: 7,
        healthCycles: 14,
        budgetAlertPercent: 80,
        usage: new Map([["linkedin-brightdata", { records: 4000, usd: 0 }]]),
      }),
    );
    const card = view.cards.find((c) => c.id === "linkedin-brightdata");
    expect(card?.history).toMatchObject({ fetched: [31], outcomes: ["ok"], latest: { fetched: 31, newCount: 1 } });
    expect(card?.status).toBe("ok");
    expect(view.cards.find((c) => c.id === "linkedin-guest")?.status).toBe("idle");
    expect(view.budgetAlertPercent).toBe(80);
    expect(view.healthCycles).toBe(14);
    const quotas = new Map(view.cascade.entries.map((e) => [e.id, e.quota]));
    expect(quotas.get("linkedin-brightdata")).toEqual({ kind: "free", used: 4000, limit: 5000 });
    expect(quotas.get("linkedin-guest")).toEqual({ kind: "none" });
  });
});
