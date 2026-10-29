// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { SearchQuery } from "@/lib/channels/types";
import type { QueryRunHistoryRow } from "@/lib/db/repos/runs";
import type { ChannelStateRow } from "@/lib/db/queries/sources";
import { rotationUnits } from "@/lib/sources/rotation-status";
import { buildSourcesView, type SourcesViewInput } from "@/lib/sources/view";

import { shippedChannels } from "../channels/helpers";

const NOW = new Date("2026-10-07T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const queries: SearchQuery[] = [
  { id: "old", keywordGroup: "targets", keywords: ["engineer"], location: "Berlin", remote: false, remoteScope: null, windowHours: 24, maxResults: 10 },
  { id: "new", keywordGroup: "remote", keywords: ["developer"], location: null, remote: true, remoteScope: "worldwide", windowHours: 24, maxResults: 10 },
];
const state = (id: string, extra: Partial<ChannelStateRow> = {}): ChannelStateRow => ({
  id, family: "linkedin", kind: "guest", health: "healthy", circuitState: "closed", circuitOpenUntil: null,
  consecutiveFailures: 0, lastErrorCode: null, lastSuccessAt: null, ...extra,
});
const row = (channelId: string, queryHash: string, hours: number, extra: Partial<QueryRunHistoryRow> = {}): QueryRunHistoryRow => ({
  channelId, queryHash, lastTurnAt: ago(hours), lastCoveredAt: ago(hours), firstSeenAt: ago(hours), ...extra,
});
function input(): SourcesViewInput {
  const config = shippedChannels();
  for (const block of Object.values(config.sources)) { block.enabled = false; delete block.markets; }
  for (const key of ["brightdata", "apify", "monid", "session", "guest"] as const) {
    config.linkedin[key].enabled = false;
    delete config.linkedin[key].markets;
  }
  config.linkedin.cascade = ["linkedin-guest"];
  config.linkedin.guest.enabled = true;
  config.sources.indeed.enabled = true;
  config.collect = { concurrency: 1, query_rotation: true, max_catch_up_hours: 168, catch_up_tolerance_hours: 6 };
  config.paid_total_monthly_budget_usd = 20;
  return {
    now: NOW, month: "2026-10", channelsConfig: config, aiConfig: { monthly_api_budget_usd: 10 },
    states: [state("linkedin-guest"), state("indeed")], usage: new Map(), runsByChannel: new Map(), runTotals: new Map(),
    latestCycle: null, aiRows: [], apiSpendUsd: 0, lastHeartbeatAt: null, heartbeatIntervalSeconds: 30, heartbeatStaleFactor: 3,
    aiWorker: { execution: "host", online: false, lastHeartbeatAt: null, ageSeconds: null, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun: null },
    rotation: { queries, history: new Map([["cascade", [row("linkedin-guest", "old", 31)]], ["indeed", [row("indeed", "old", 40)] ]]) },
  };
}

describe("sources query rotation", () => {
  it("builds a cascade unit and only enabled independent keyword units", () => {
    const data = input();
    data.channelsConfig.sources.arbeitnow.enabled = true;
    expect(rotationUnits(data.channelsConfig)).toEqual([{ name: "cascade", channelIds: ["linkedin-guest"] }, { name: "indeed", channelIds: ["indeed"] }]);
    data.channelsConfig.linkedin.cascade = [];
    expect(rotationUnits(data.channelsConfig).map((unit) => unit.name)).toEqual(["linkedin-guest", "indeed"]);
  });

  it("shows waits and the oldest query's group and place, sharing one cascade line", () => {
    const view = buildSourcesView(input());
    expect(view.cascade.rotation).toEqual({ sortChannel: "linkedin-guest", queries: 2, neverRun: 1, oldestWaitHours: 31,
      oldestWaiting: { id: "old", keywordGroup: "targets", location: "Berlin", remoteScope: null }, overCap: 0, maxCatchUpHours: 168 });
    expect(view.cards.find((card) => card.id === "indeed")?.rotation?.oldestWaitHours).toBe(40);
    expect(view.cards.find((card) => card.id === "linkedin-guest")?.rotation).toBeUndefined();
  });

  it("uses full family coverage for capped gaps, including first appearance after failed coverage", () => {
    const data = input();
    data.channelsConfig.linkedin.cascade = ["linkedin-guest", "linkedin-monid"];
    data.rotation = { queries, history: new Map([["cascade", [row("linkedin-guest", "old", 300), row("linkedin-monid", "old", 10),
      row("linkedin-guest", "new", 200, { lastCoveredAt: null })]]]) };
    const rotation = buildSourcesView(data).cascade.rotation;
    expect(rotation).toMatchObject({ oldestWaitHours: 300, overCap: 1 });
  });

  it("counts all unseen queries as never run without inventing a wait or capped gap", () => {
    const data = input();
    data.rotation = { queries, history: new Map() };
    expect(buildSourcesView(data).cascade.rotation).toMatchObject({ queries: 2, neverRun: 2, oldestWaitHours: null, oldestWaiting: null, overCap: 0 });
  });

  it.each(["off", "no queries", "unavailable history"])("hides rotation when %s", (reason) => {
    const data = input();
    if (reason === "off") data.channelsConfig.collect.query_rotation = false;
    else if (reason === "no queries") data.rotation = { queries: [], history: new Map() };
    else delete data.rotation;
    const view = buildSourcesView(data);
    expect(view.cascade.rotation).toBeUndefined();
    expect(view.cards.every((card) => card.rotation === undefined)).toBe(true);
  });

  it("does not mark gaps over cap when catch-up is disabled", () => {
    const data = input();
    data.channelsConfig.collect.max_catch_up_hours = 0;
    data.rotation = { queries, history: new Map([["cascade", [row("linkedin-guest", "old", 300)]]]) };
    expect(buildSourcesView(data).cascade.rotation).toMatchObject({ overCap: 0, oldestWaitHours: 300 });
  });

  it.each(["disabled", "credentials", "missing env", "budget", "global cap", "open", "unregistered", "paid without quota", "spent free quota"])("skips a cascade entry that is %s", (reason) => {
    const data = input();
    data.channelsConfig.linkedin.cascade = ["linkedin-brightdata", "linkedin-guest"];
    const bright = data.channelsConfig.linkedin.brightdata;
    bright.enabled = true;
    bright.free_records_per_month = 0;
    bright.monthly_budget_usd = 5;
    data.states = [state("linkedin-brightdata", { kind: "paid" }), ...data.states];
    if (reason === "disabled") bright.enabled = false;
    if (reason === "credentials") data.brightdataConfigured = false;
    if (reason === "missing env") data.env = {};
    if (reason === "budget") data.usage = new Map([["linkedin-brightdata", { records: 0, usd: 5 }]]);
    if (reason === "global cap") data.usage = new Map([["another", { records: 0, usd: 20 }]]);
    if (reason === "open") data.states = [state("linkedin-brightdata", { circuitState: "open", circuitOpenUntil: ago(-1) }), state("linkedin-guest")];
    if (reason === "unregistered") data.states = [state("linkedin-guest")];
    if (reason === "paid without quota") bright.monthly_budget_usd = 0;
    if (reason === "spent free quota") {
      bright.monthly_budget_usd = 0;
      bright.free_records_per_month = 10;
      data.states = [state("linkedin-brightdata", { kind: "api" }), state("linkedin-guest")];
      data.usage = new Map([["linkedin-brightdata", { records: 10, usd: 0 }]]);
    }
    expect(buildSourcesView(data).cascade.rotation?.sortChannel).toBe("linkedin-guest");
  });

  it.each(["missing", "expired", "valid"] as const)("matches the collector's session credential-presence check for a %s login", (status) => {
    const data = input();
    data.channelsConfig.linkedin.cascade = ["linkedin-session", "linkedin-guest"];
    data.channelsConfig.linkedin.session.enabled = true;
    data.states = [state("linkedin-session", { kind: "session" }), ...data.states];
    data.linkedinLogin = { status, reason: status === "expired" ? "cookie_expired" : null };
    expect(buildSourcesView(data).cascade.rotation?.sortChannel).toBe(status === "missing" ? "linkedin-guest" : "linkedin-session");
  });

  it("uses start-channel turns rather than merged family turns", () => {
    const data = input();
    data.channelsConfig.linkedin.cascade = ["linkedin-brightdata", "linkedin-guest"];
    data.channelsConfig.linkedin.brightdata.enabled = true;
    data.states = [state("linkedin-brightdata", { kind: "paid" }), ...data.states];
    data.rotation = { queries, history: new Map([["cascade", [row("linkedin-guest", "old", 300), row("linkedin-brightdata", "old", 10)]]]) };
    expect(buildSourcesView(data).cascade.rotation).toMatchObject({ sortChannel: "linkedin-brightdata", oldestWaitHours: 10, neverRun: 1 });
  });

  it("lets remaining free records run even when the global paid cap is full", () => {
    const data = input();
    data.channelsConfig.linkedin.cascade = ["linkedin-brightdata", "linkedin-guest"];
    data.channelsConfig.linkedin.brightdata.enabled = true;
    data.channelsConfig.linkedin.brightdata.free_records_per_month = 10;
    data.channelsConfig.linkedin.brightdata.cost_per_1k_usd = 1.5;
    data.usage = new Map([["another", { records: 0, usd: 20 }], ["linkedin-brightdata", { records: 9, usd: 0 }]]);
    data.states = [state("linkedin-brightdata", { kind: "paid" }), ...data.states];
    expect(buildSourcesView(data).cascade.rotation?.sortChannel).toBe("linkedin-brightdata");
  });

  it.each(["brightdata", "apify", "monid"] as const)("uses the configured %s unit price for channel and global headroom", (provider) => {
    for (const scope of ["channel", "global"] as const) {
      for (const [remaining, affordable] of [[0.001, false], [0.0015, true], [0.0014996, true], [0.0014994, false]] as const) {
        const data = input();
        const id = `linkedin-${provider}` as const;
        data.channelsConfig.linkedin.cascade = [id, "linkedin-guest"];
        const block = data.channelsConfig.linkedin[provider];
        block.enabled = true;
        block.monthly_budget_usd = scope === "channel" ? remaining : 5;
        data.channelsConfig.linkedin.brightdata.free_records_per_month = 10;
        if (provider === "brightdata") data.channelsConfig.linkedin.brightdata.cost_per_1k_usd = 1.5;
        else data.channelsConfig.linkedin[provider].price_per_1k_usd = 1.5;
        data.channelsConfig.paid_total_monthly_budget_usd = scope === "global" ? remaining : 20;
        data.usage = new Map([[id, { records: 10, usd: 0 }]]);
        data.states = [state(id, { kind: "paid" }), ...data.states];
        data.rotation = { queries, history: new Map([["cascade", [row(id, "new", 10), row("linkedin-guest", "old", 31)]]]) };
        expect(buildSourcesView(data).cascade.rotation).toMatchObject({
          sortChannel: affordable ? id : "linkedin-guest",
          oldestWaitHours: affordable ? 10 : 31,
          oldestWaiting: { id: affordable ? "new" : "old" },
        });
      }
    }
  });

  it("lets a zero-price paid channel start after its free allowance and both budgets are exhausted", () => {
    const data = input();
    data.channelsConfig.linkedin.cascade = ["linkedin-brightdata", "linkedin-guest"];
    Object.assign(data.channelsConfig.linkedin.brightdata, {
      enabled: true, free_records_per_month: 10, monthly_budget_usd: 0, cost_per_1k_usd: 0,
    });
    data.channelsConfig.paid_total_monthly_budget_usd = 0;
    data.usage = new Map([["linkedin-brightdata", { records: 10, usd: 1 }]]);
    data.states = [state("linkedin-brightdata", { kind: "paid" }), ...data.states];
    expect(buildSourcesView(data).cascade.rotation?.sortChannel).toBe("linkedin-brightdata");
  });

  it("treats an open circuit past cooldown as available without mutating the snapshot", () => {
    const data = input();
    const cooled = state("linkedin-guest", { circuitState: "open", circuitOpenUntil: ago(1), health: "down" });
    data.states = [cooled];
    expect(buildSourcesView(data).cascade.rotation?.sortChannel).toBe("linkedin-guest");
    expect(cooled).toMatchObject({ circuitState: "open", health: "down" });
  });

  it("reports no start channel without claiming wait or never-run statistics", () => {
    const data = input();
    data.states = [];
    expect(buildSourcesView(data).cascade.rotation).toMatchObject({ sortChannel: null, queries: 2, neverRun: 0, oldestWaitHours: null, oldestWaiting: null });
  });
});
