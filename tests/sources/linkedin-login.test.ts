import { describe, expect, it } from "vitest";

import { buildSourcesView, type SourcesViewInput } from "@/lib/sources/view";

import { shippedChannels } from "../channels/helpers";

const NOW = new Date("2026-10-07T12:00:00Z");

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

describe("/sources: the LinkedIn login", () => {
  it("shows the saved login on the two session channels and on the cascade entry, and on no other channel", () => {
    const view = buildSourcesView(input({ linkedinLogin: { status: "missing", reason: null } }));
    const withLogin = view.cards.filter((c) => c.login !== null).map((c) => c.id);
    expect(withLogin).toEqual(["linkedin-session", "linkedin-session:recommended"]);
    expect(view.cards.find((c) => c.id === "linkedin-session")?.login).toEqual({ status: "missing", reason: null });
    expect(view.cascade.entries.filter((e) => e.login !== null).map((e) => e.id)).toEqual(["linkedin-session"]);
  });

  it("carries valid and expired logins (with the reason) through", () => {
    const valid = buildSourcesView(input({ linkedinLogin: { status: "valid", reason: null } }));
    expect(valid.cards.find((c) => c.id === "linkedin-session")?.login?.status).toBe("valid");
    const expired = buildSourcesView(input({ linkedinLogin: { status: "expired", reason: "checkpoint" } }));
    expect(expired.cascade.entries.find((e) => e.id === "linkedin-session")?.login).toEqual({ status: "expired", reason: "checkpoint" });
  });

  it("shows no login badge when the caller does not know the login", () => {
    const view = buildSourcesView(input());
    expect(view.cards.every((c) => c.login === null)).toBe(true);
  });

  it("lists the recommended side channel as its own card, after the cascade, with its own switch", () => {
    const config = shippedChannels();
    const view = buildSourcesView(input({ channelsConfig: { ...config, linkedin: { ...config.linkedin, session: { ...config.linkedin.session, enabled: true } } } }));
    const ids = view.cards.map((c) => c.id);
    expect(ids.indexOf("linkedin-session:recommended")).toBeGreaterThan(ids.indexOf("linkedin-guest"));
    expect(view.cards.find((c) => c.id === "linkedin-session:recommended")).toMatchObject({ enabled: true });
    expect(view.cascade.entries.map((e) => e.id)).not.toContain("linkedin-session:recommended");
  });
});
