// @vitest-environment node
import { describe, expect, it } from "vitest";

import { boardRegistryStatus, channelRegistryStatus, registryTone, STATUS_SEVERITY, type BoardStatusInput } from "@/lib/sources/registry/status";

import { boardHealth, cardsFor, HOUR, NOW, state } from "./registry-helpers";

const settings = { board_failing_after: 2, board_stale_hours: 48 };

function board(extra: Partial<BoardStatusInput>): ReturnType<typeof boardRegistryStatus> {
  return boardRegistryStatus({ enabled: true, channelEnabled: true, channelId: "greenhouse", health: null, now: NOW, settings, ...extra });
}

describe("channel verdicts follow the /sources card", () => {
  const card = (id: string, extra: Parameters<typeof state>[1] = {}, input: Parameters<typeof cardsFor>[0] = {}) => {
    const found = cardsFor({ states: [state(id, extra)], ...input }).find((c) => c.id === id);
    if (!found) throw new Error(`no card ${id}`);
    return found;
  };

  it("an open circuit is failing, with the error, the streak and the cooldown", () => {
    const verdict = channelRegistryStatus(card("indeed", { circuitState: "open", circuitOpenUntil: new Date(NOW.getTime() + 5 * HOUR), consecutiveFailures: 3, lastErrorCode: "blocked" }));
    expect(verdict.status).toBe("failing");
    expect(verdict.reasons.map((r) => r.key)).toEqual(["lastRunFailed", "consecutive", "circuitUntil"]);
    expect(verdict.reasons[0]?.values).toEqual({ error: "blocked" });
  });

  it("an expired cooldown is a probe: unstable", () => {
    const verdict = channelRegistryStatus(card("indeed", { circuitState: "open", circuitOpenUntil: new Date(NOW.getTime() - HOUR), consecutiveFailures: 3 }));
    expect(verdict).toMatchObject({ status: "degraded", reasons: [{ key: "halfOpen" }] });
  });

  it("a channel without a row has never run; a registered one without runs too", () => {
    expect(channelRegistryStatus(card("indeed")).status).toBe("never_run");
    const none = cardsFor({}).find((c) => c.id === "indeed");
    expect(none && channelRegistryStatus(none).reasons).toEqual([{ key: "notRegistered" }]);
  });

  it("a switched-off channel is off with its own reason; a missing key is not configured and names only the variable", () => {
    const off = cardsFor({ states: [state("jsearch")] }).find((c) => c.id === "jsearch");
    expect(off && channelRegistryStatus(off)).toEqual({ status: "off", reasons: [{ key: "offChannel" }] });
    const tavily = cardsFor({ states: [state("tavily")], env: {}, tavilyConfigured: false }).find((c) => c.id === "tavily");
    expect(tavily?.enabled).toBe(true);
    expect(tavily && channelRegistryStatus(tavily)).toEqual({ status: "not_configured", reasons: [{ key: "missingEnv", values: { names: "TAVILY_API_KEY" } }] });
  });

  it("a LinkedIn session without a login says so", () => {
    const config = cardsFor({ states: [state("linkedin-session")], linkedinLogin: { status: "missing", reason: null } }).find((c) => c.id === "linkedin-session");
    expect(config?.enabled).toBe(false);
  });
});

describe("board verdicts: the first matching rule wins", () => {
  it("switched off (the board itself, then its ATS channel), before anything else", () => {
    expect(board({ enabled: false, health: boardHealth("greenhouse", "x", { lastStatus: "error", consecutiveFailures: 9 }) })).toEqual({ status: "off", reasons: [{ key: "offBoard" }] });
    expect(board({ channelEnabled: false, health: boardHealth("greenhouse", "x", { lastStatus: "error", consecutiveFailures: 9 }) })).toEqual({ status: "off", reasons: [{ key: "parentOff", values: { channel: "greenhouse" } }] });
  });

  it("no check record = never run", () => {
    expect(board({})).toEqual({ status: "never_run", reasons: [{ key: "neverChecked" }] });
  });

  it("failing at the threshold, unstable one below it", () => {
    const failed = (n: number) => boardHealth("greenhouse", "x", { lastStatus: "error", lastErrorCode: "not_found", consecutiveFailures: n });
    expect(board({ health: failed(2) })).toEqual({ status: "failing", reasons: [{ key: "boardFailing", values: { count: 2, error: "not_found" } }] });
    expect(board({ health: failed(1) })).toEqual({ status: "degraded", reasons: [{ key: "boardFailedOnce", values: { error: "not_found" } }] });
  });

  it("stale only when the last check is older than the limit", () => {
    const checked = (hours: number) => boardHealth("greenhouse", "x", { lastCheckedAt: new Date(NOW.getTime() - hours * HOUR) });
    expect(board({ health: checked(48) }).status).toBe("ok");
    expect(board({ health: checked(49) })).toEqual({ status: "degraded", reasons: [{ key: "boardStale", values: { hours: 49 } }] });
    expect(board({ health: checked(1) })).toEqual({ status: "ok", reasons: [] });
  });

  it("a 304 counts as healthy", () => {
    expect(board({ health: boardHealth("greenhouse", "x", { lastStatus: "not_modified" }) }).status).toBe("ok");
  });
});

describe("tones and order", () => {
  it("maps the statuses to the card colours and sorts failing first", () => {
    expect([registryTone("ok"), registryTone("degraded"), registryTone("failing"), registryTone("off"), registryTone("not_configured"), registryTone("never_run")]).toEqual(["good", "warn", "bad", "idle", "idle", "idle"]);
    expect(STATUS_SEVERITY.failing).toBeLessThan(STATUS_SEVERITY.degraded);
    expect(STATUS_SEVERITY.ok).toBeLessThan(STATUS_SEVERITY.off);
  });
});
