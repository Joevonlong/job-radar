// @vitest-environment node
import { describe, expect, it } from "vitest";

import { REGISTRY_DEFAULTS } from "@/lib/config";
import type { ChannelCycleStat } from "@/lib/db/queries/sources";
import type { SourceRegistryRow } from "@/lib/db/repos/source-registry";
import { registryTone, STATUS_SEVERITY } from "@/lib/sources/registry/status";
import { boardPageUrl, buildRegistryView, buildRegistryViewFromMirror, sortBoards } from "@/lib/sources/registry/view";

import { channelsWith, shippedChannels } from "../channels/helpers";
import { boardHealth, cardsFor, HOUR, NOW, state, windowStat } from "./registry-helpers";

// xing is switched off in the shipped file; the cases below need it on
const shipped = shippedChannels();
const config = { ...shipped, sources: { ...shipped.sources, xing: { ...shipped.sources.xing, enabled: true } } };
const failing = state("xing", { circuitState: "open", circuitOpenUntil: new Date(NOW.getTime() + HOUR), consecutiveFailures: 3, lastErrorCode: "blocked" });

function view(overrides: Partial<Parameters<typeof buildRegistryView>[0]> = {}) {
  return buildRegistryView({
    now: NOW,
    config,
    cards: cardsFor({ channelsConfig: config, states: [state("greenhouse"), failing] }),
    channelStats: new Map([["xing", windowStat({ runs: 4, failed: 4, lastRun: { startedAt: NOW, status: "failed", errorCode: "blocked", interrupted: false } })], ["greenhouse", windowStat({ runs: 6, fetched: 812, newCount: 14 })]]),
    boardHealth: [
      boardHealth("greenhouse", "zellwerk"),
      boardHealth("greenhouse", "gegensprech", { lastStatus: "error", lastErrorCode: "not_found", consecutiveFailures: 3 }),
      boardHealth("greenhouse", "werbenetz", { lastCheckedAt: new Date(NOW.getTime() - 72 * HOUR) }),
    ],
    boardSeen: new Map([["greenhouse:zellwerk", 7]]),
    ...overrides,
  });
}

describe("buildRegistryView", () => {
  it("has a row for every channel and every board, and the counts add up", () => {
    const v = view();
    expect(v.channels).toHaveLength(20);
    expect(v.boards).toHaveLength(config.ats_boards.length);
    expect(v.total).toBe(20 + config.ats_boards.length);
    expect(Object.values(v.counts).reduce((a, b) => a + b, 0)).toBe(v.total);
    expect(v.windowDays).toBe(7);
    expect(v.fromMirror).toBe(false);
  });

  it("gives the seeded cases their states", () => {
    const v = view();
    const byId = new Map([...v.channels, ...v.boards].map((r) => [r.id, r]));
    expect(byId.get("xing")?.status).toBe("failing");
    expect(byId.get("greenhouse")?.status).toBe("never_run"); // registered, but no cycle history in this fixture
    expect(byId.get("board:greenhouse:zellwerk")).toMatchObject({ status: "ok", seen: 7, lastTotal: 10, lastKept: 3 });
    expect(byId.get("board:greenhouse:gegensprech")).toMatchObject({ status: "failing" });
    expect(byId.get("board:greenhouse:werbenetz")).toMatchObject({ status: "degraded" });
    expect(byId.get("board:greenhouse:datenhaus")).toMatchObject({ status: "never_run", lastCheck: null });
  });

  it("carries the window numbers and the ATS summary of a channel", () => {
    const v = view();
    const greenhouse = v.channels.find((c) => c.id === "greenhouse");
    expect(greenhouse?.window).toEqual({ runs: 6, failed: 0, fetched: 812, newCount: 14 });
    const total = config.ats_boards.filter((b) => b.ats === "greenhouse").length;
    expect(greenhouse?.boards).toEqual({ total, failing: 1, degraded: 1, neverRun: total - 3 });
    expect(v.channels.find((c) => c.id === "xing")?.boards).toBeNull();
  });

  it("a board of a switched-off ATS channel is off", () => {
    const off = { ...config, sources: { ...config.sources, greenhouse: { ...config.sources.greenhouse, enabled: false } } };
    const v = view({ config: off, cards: cardsFor({ channelsConfig: off }) });
    expect(v.boards.find((b) => b.id === "board:greenhouse:zellwerk")).toMatchObject({ status: "off", reasons: [{ key: "parentOff" }] });
  });

  it("builds the career page url from the template, Lever EU included", () => {
    expect(boardPageUrl(REGISTRY_DEFAULTS, { ats: "greenhouse", token: "zellwerk" })).toBe("https://job-boards.greenhouse.io/zellwerk");
    expect(boardPageUrl(REGISTRY_DEFAULTS, { ats: "lever", token: "acme", region: "eu" })).toBe("https://jobs.eu.lever.co/acme");
    expect(boardPageUrl(REGISTRY_DEFAULTS, { ats: "lever", token: "acme", region: "global" })).toBe("https://jobs.lever.co/acme");
    expect(boardPageUrl(REGISTRY_DEFAULTS, { ats: "personio", token: "jedwerk" })).toBe("https://jedwerk.jobs.personio.de");
  });

  it("sorts boards failing, unstable, never run, ok, off, then by name", () => {
    const v = view();
    const sorted = sortBoards(v.boards).map((b) => b.status);
    const order = ["failing", "degraded", "never_run", "ok", "not_configured", "off"];
    expect(sorted.map((s) => order.indexOf(s))).toEqual([...sorted.map((s) => order.indexOf(s))].sort((a, b) => a - b));
  });
});

describe("buildRegistryViewFromMirror", () => {
  const row = (id: string, extra: Partial<SourceRegistryRow>): SourceRegistryRow => ({
    id,
    type: "channel",
    sourceGroup: "job_boards",
    name: id,
    parentId: null,
    enabled: true,
    params: {},
    inConfig: true,
    removedAt: null,
    configHash: "h",
    firstSyncedAt: NOW,
    syncedAt: NOW,
    ...extra,
  });

  it("shows the last synced entries with the live health", () => {
    const v = buildRegistryViewFromMirror({
      now: NOW,
      rows: [
        row("xing", {}),
        row("indeed", { enabled: false }),
        row("greenhouse", { sourceGroup: "ats" }),
        row("board:greenhouse:zellwerk", { type: "ats_board", sourceGroup: "ats", name: "Zellwerk", parentId: "greenhouse", params: { ats: "greenhouse", token: "zellwerk" } }),
      ],
      channelStats: new Map([["xing", windowStat({ lastRun: { startedAt: NOW, status: "failed", errorCode: "blocked", interrupted: false } })]]),
      boardHealth: [boardHealth("greenhouse", "zellwerk")],
      boardSeen: new Map(),
      settings: REGISTRY_DEFAULTS,
    });
    expect(v.fromMirror).toBe(true);
    expect(v.channels.map((c) => [c.id, c.status])).toEqual([["xing", "failing"], ["indeed", "off"], ["greenhouse", "never_run"]]);
    expect(v.boards[0]).toMatchObject({ id: "board:greenhouse:zellwerk", status: "ok" });
    expect(v.total).toBe(4);
  });
});

describe("skipped runs, cascade standby, the recommended switch, one time basis", () => {
  /** Every key the cases depend on is set here; nothing is read from what the shipped file happens to say. */
  const own = (session: boolean) =>
    channelsWith((raw) => {
      const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
      (linkedin as unknown as { cascade: string[] }).cascade = ["linkedin-brightdata", "linkedin-apify", "linkedin-session", "linkedin-guest"];
      for (const key of ["brightdata", "apify", "session", "guest"] as const) (linkedin[key] as Record<string, unknown>).enabled = key === "session" ? session : true;
      (linkedin.session as Record<string, unknown>).recommended_daily = true;
    });
  const build = (cfg: ReturnType<typeof own>, cards: ReturnType<typeof cardsFor>, stats = new Map<string, ReturnType<typeof windowStat>>()) =>
    buildRegistryView({ now: NOW, config: cfg, cards, channelStats: stats, boardHealth: [], boardSeen: new Map() });
  const stat = (extra: Partial<ChannelCycleStat>): ChannelCycleStat => ({ cycleId: 1, runs: 1, succeeded: 0, partial: 0, failed: 0, skipped: 1, interrupted: 0, running: 0, fetched: 0, newCount: 0, ...extra });

  it("a channel whose newest cycles were only skipped is unstable with the skip reason, even after an earlier success", () => {
    const cfg = own(false);
    const run = { id: 1, cycleId: 2, startedAt: NOW, finishedAt: NOW, status: "skipped" as const, fetched: 0, newCount: 0, cost: 0, errorCode: "budget_exceeded", error: "no available channel", interrupted: false };
    const cards = cardsFor({
      channelsConfig: cfg,
      states: [state("linkedin-brightdata")],
      history: new Map([["linkedin-brightdata", [stat({ cycleId: 1, skipped: 0, succeeded: 1 }), stat({ cycleId: 2 }), stat({ cycleId: 3 })]]]),
      healthCycles: 14,
      runsByChannel: new Map([["linkedin-brightdata", [run]]]),
    });
    const row = build(cfg, cards).channels.find((c) => c.id === "linkedin-brightdata");
    expect(row).toMatchObject({ status: "degraded", reasons: [{ key: "skipped", values: { count: 2, error: "budget_exceeded" } }] });
  });

  it("an enabled cascade step behind an available one that was never reached is on standby, sorted after ok", () => {
    const cfg = own(false);
    const cards = cardsFor({
      channelsConfig: cfg,
      states: [state("linkedin-brightdata"), state("linkedin-apify"), state("linkedin-guest")],
      history: new Map([["linkedin-brightdata", [stat({ skipped: 0, succeeded: 1 })]]]),
      healthCycles: 14,
      apifyConfigured: true,
    });
    const v = build(cfg, cards);
    const status = (id: string) => v.channels.find((c) => c.id === id);
    expect(status("linkedin-brightdata")?.status).toBe("ok");
    expect(status("linkedin-apify")).toMatchObject({ status: "standby", reasons: [{ key: "cascadeStandby" }] });
    expect(status("linkedin-guest")?.status).toBe("standby");
    // the first step of the cascade has nothing before it: never standby
    const alone = build(cfg, cardsFor({ channelsConfig: cfg, states: [state("linkedin-brightdata")] }));
    expect(alone.channels.find((c) => c.id === "linkedin-brightdata")?.status).toBe("never_run");
    expect(STATUS_SEVERITY.standby).toBeGreaterThan(STATUS_SEVERITY.ok);
    expect(registryTone("standby")).toBe("idle");
  });

  it("the recommended read is locked behind linkedin-session while that is off", () => {
    const off = build(own(false), cardsFor({ channelsConfig: own(false) })).channels.find((c) => c.id === "linkedin-session:recommended");
    expect(off).toMatchObject({ enabled: false, needsParent: "linkedin-session", status: "off", reasons: [{ key: "parentOff", values: { channel: "linkedin-session" } }] });
    const on = build(own(true), cardsFor({ channelsConfig: own(true) })).channels.find((c) => c.id === "linkedin-session:recommended");
    expect(on).toMatchObject({ enabled: true, needsParent: null });
  });

  it("the last run is dated by its end, like the last success", () => {
    const cfg = own(true);
    const started = new Date(NOW.getTime() - 2 * 60_000);
    const stats = new Map([["linkedin-brightdata", windowStat({ runs: 1, lastRun: { startedAt: started, finishedAt: NOW, status: "succeeded", errorCode: null, interrupted: false } })]]);
    expect(build(cfg, cardsFor({ channelsConfig: cfg, states: [state("linkedin-brightdata")] }), stats).channels.find((c) => c.id === "linkedin-brightdata")?.lastRun?.at).toBe(NOW.toISOString());
  });
});
