import { describe, expect, it } from "vitest";

import {
  aiAllProvidersFailed,
  buildAlerts,
  collectErrorsOf,
  cycleIncompleteAlert,
  dedupeAlerts,
  queuedAlertToCandidate,
  silentQuotaRecoveries,
  type AlertInput,
  type AlertQuota,
  type AlertQuotaInput,
} from "@/lib/notify/alerts";
import { aiQuotaHoldOf, failedSourcesOf } from "@/lib/notify/step";
import { notifyText } from "@/lib/notify/text";

const ZH = notifyText("zh");

const empty: AlertInput = { channels: [], collectErrors: [], budgets: [], budgetThresholds: [0.8, 1], aiAllProvidersFailed: false };
const channel = (id: string, over: Partial<AlertInput["channels"][number]> = {}) => ({ id, family: "linkedin", enabled: true, circuitState: "closed" as const, lastErrorCode: null, ...over });
const kinds = (input: Partial<AlertInput>) => buildAlerts({ ...empty, ...input }, ZH).map((a) => `${a.kind}:${a.key}`);

describe("buildAlerts", () => {
  it("has nothing to say when all is well", () => {
    expect(buildAlerts({ ...empty, channels: [channel("a")], budgets: [{ scope: "global", usedUsd: 1, capUsd: 100 }] }, ZH)).toEqual([]);
  });

  it("alerts for an open circuit of an enabled channel only", () => {
    expect(
      kinds({ channels: [channel("a", { circuitState: "open", lastErrorCode: "rate_limited" }), channel("b", { circuitState: "open", enabled: false }), channel("c", { circuitState: "half_open" })] }),
    ).toEqual(["circuit_open:a"]);
    const [alert] = buildAlerts({ ...empty, channels: [channel("a", { circuitState: "open", lastErrorCode: "rate_limited" })] }, ZH);
    expect(alert?.detail).toContain("rate_limited");
  });

  it("alerts for an expired login of any channel and a verification page of a LinkedIn channel", () => {
    const result = kinds({
      channels: [channel("li", { family: "linkedin" }), channel("ind", { family: "indeed" })],
      collectErrors: [
        { channelId: "li", errorCodes: { auth_expired: 2, blocked: 1 } },
        { channelId: "ind", errorCodes: { auth_expired: 1, blocked: 3 } }, // blocked on a non-LinkedIn board is no alert
      ],
    });
    expect(result).toEqual(["auth_expired:li", "verification:li", "auth_expired:ind"]);
  });

  it("raises the highest crossed budget threshold per scope, none below the first", () => {
    const budget = (scope: string, usedUsd: number, capUsd = 100) => ({ scope, usedUsd, capUsd });
    expect(kinds({ budgets: [budget("a", 79.9), budget("b", 80), budget("c", 99), budget("d", 100), budget("e", 250), budget("f", 5, 0)] })).toEqual([
      "budget_80:b",
      "budget_80:c",
      "budget_100:d",
      "budget_100:e",
    ]);
  });

  it("uses the configured thresholds", () => {
    expect(kinds({ budgetThresholds: [0.5], budgets: [{ scope: "a", usedUsd: 60, capUsd: 100 }] })).toEqual(["budget_50:a"]);
  });

  it("alerts when every AI provider failed", () => {
    expect(kinds({ aiAllProvidersFailed: true })).toEqual(["ai_failed:all"]);
  });
});

describe("cycleIncompleteAlert", () => {
  it("is keyed by the cycle id, or by the kind when there is none", () => {
    expect(cycleIncompleteAlert({ cycleId: 12, kind: "weekday_morning", reason: { code: "cycle_failed", detail: "r" } }, ZH)).toMatchObject({ kind: "cycle_incomplete", key: "12" });
    expect(cycleIncompleteAlert({ cycleId: null, kind: "runner", reason: { code: "cycle_failed", detail: "r" } }, ZH)).toMatchObject({ key: "runner" });
  });
});

describe("dedupeAlerts", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const alert = (kind: string, key: string) => ({ kind, key, title: "t", detail: "d" });

  it("drops an alert of the same kind and key sent within the window", () => {
    const sent = [{ kind: "circuit_open", key: "a", sentAt: hoursAgo(23.9) }];
    const result = dedupeAlerts([alert("circuit_open", "a"), alert("circuit_open", "b"), alert("budget_80", "a")], sent, { now, windowHours: 24 });
    expect(result.map((a) => `${a.kind}:${a.key}`)).toEqual(["circuit_open:b", "budget_80:a"]);
  });

  it("sends the same alert again once the window has passed", () => {
    const sent = [{ kind: "circuit_open", key: "a", sentAt: hoursAgo(24.1) }];
    expect(dedupeAlerts([alert("circuit_open", "a")], sent, { now, windowHours: 24 })).toHaveLength(1);
  });

  it("honours a configured window", () => {
    const sent = [{ kind: "k", key: "a", sentAt: hoursAgo(30) }];
    expect(dedupeAlerts([alert("k", "a")], sent, { now, windowHours: 48 })).toEqual([]);
  });

  it("keeps one of identical alerts raised together", () => {
    expect(dedupeAlerts([alert("k", "a"), alert("k", "a")], [], { now, windowHours: 24 })).toHaveLength(1);
  });

  it("does not confuse kind/key boundaries", () => {
    const sent = [{ kind: "a", key: "b:c", sentAt: hoursAgo(1) }];
    expect(dedupeAlerts([alert("a:b", "c")], sent, { now, windowHours: 24 })).toHaveLength(1);
  });
});

describe("reading cycle results", () => {
  it("extracts error codes per channel from the collect result and survives junk", () => {
    expect(collectErrorsOf({ channels: { a: { errorCodes: { auth_expired: 1 } }, b: {} } })).toEqual([
      { channelId: "a", errorCodes: { auth_expired: 1 } },
      { channelId: "b", errorCodes: {} },
    ]);
    expect(collectErrorsOf(undefined)).toEqual([]);
    expect(collectErrorsOf({ channels: "x" })).toEqual([]);
  });

  it("recognises 'no AI provider could handle' failures only", () => {
    const sub = (error: string) => ({ subtasks: [{ status: "failed", error }] });
    expect(aiAllProvidersFailed(sub('AiUnavailableError: no AI provider could handle task "score": ...'))).toBe(true);
    expect(aiAllProvidersFailed(sub("TypeError: boom"))).toBe(false);
    expect(aiAllProvidersFailed({ subtasks: [{ status: "ok" }] })).toBe(false);
    expect(aiAllProvidersFailed(null)).toBe(false);
  });

  it("lists failed and given-up sources of the collect result", () => {
    expect(
      failedSourcesOf({
        channels: { a: { failed: 2, errorCodes: { rate_limited: 2 } }, b: { failed: 0, errorCodes: { parse: 3 } }, c: { failed: 1, errorCodes: {} } },
        unusable: { c: "budget_exceeded", d: "auth_expired" },
      }),
    ).toEqual([
      { channelId: "a", reasons: ["rate_limited"] },
      { channelId: "c", reasons: ["budget_exceeded"] },
      { channelId: "d", reasons: ["auth_expired"] },
    ]);
    expect(failedSourcesOf(null)).toEqual([]);
  });

  it("lists a source whose queries were interrupted after some pages, not one with only invalid records", () => {
    expect(
      failedSourcesOf({
        channels: { cut: { failed: 0, interrupted: 1, errorCodes: { parse: 1 } }, invalid: { failed: 0, interrupted: 0, errorCodes: { parse: 1 } } },
      }),
    ).toEqual([{ channelId: "cut", reasons: ["parse"] }]);
  });
});

describe("queuedAlertToCandidate", () => {
  it("reads title, detail and key from the payload and remembers the row", () => {
    expect(queuedAlertToCandidate({ id: 9, kind: "backup_failed", payload: { key: "nightly", title: "备份失败", message: "exit 1", extra: 1 } }, ZH)).toEqual({
      kind: "backup_failed",
      key: "nightly",
      title: "备份失败",
      detail: "exit 1",
      notificationId: 9,
    });
  });

  it("falls back to the kind for a missing or malformed payload", () => {
    for (const payload of [null, "text", 42, { title: 5 }]) {
      expect(queuedAlertToCandidate({ id: 1, kind: "x", payload }, ZH)).toMatchObject({ kind: "x", key: "", title: "告警：x", detail: "" });
    }
  });
});

describe("alerts in English", () => {
  const EN = notifyText("en");

  it("words circuit, budget, AI, incomplete-run, worker and queued alerts in the Telegram language", () => {
    const alerts = buildAlerts(
      {
        ...empty,
        channels: [channel("indeed", { circuitState: "open", lastErrorCode: "rate_limited" })],
        budgets: [
          { scope: "channel:apify", usedUsd: 9, capUsd: 10 },
          { scope: "global", usedUsd: 20, capUsd: 20 },
          { scope: "ai-api", usedUsd: 8, capUsd: 10 },
        ],
        budgetThresholds: [0.8, 1],
        aiAllProvidersFailed: true,
      },
      EN,
    );
    expect(alerts.map((a) => a.title)).toEqual([
      "Channel indeed is paused (circuit breaker)",
      "Channel apify: 90% of the budget used",
      "Collection: 100% of the total budget used",
      "AI API: 80% of the budget used",
      "Every AI provider failed",
    ]);
    expect(alerts[0]?.detail).toContain("last error: rate_limited");
    expect(alerts[2]?.detail).toBe("$20.00 of $20.00 used this month (alert at 100%). At the cap the calls that would cost more are skipped.");
    expect(cycleIncompleteAlert({ cycleId: null, kind: "runner", reason: { code: "orphaned_on_restart", count: 2 } }, EN)).toMatchObject({
      title: "A run did not finish (runner)",
      detail: "2 runs were still open when the runner restarted and were marked as failed.",
    });
    expect(cycleIncompleteAlert({ cycleId: 4, kind: "manual", reason: { code: "cycle_failed", detail: null } }, ZH).detail).toBe("这一轮以失败结束（见 /sources 的运行记录）。");
    expect(queuedAlertToCandidate({ id: 1, kind: "backup_failed", payload: {} }, EN).title).toBe("Alert: backup_failed");
  });
});

describe("usage-cap alerts (state changes only)", () => {
  const NOW = new Date("2026-10-07T10:00:00Z");
  const quota = (over: Partial<AlertQuota> = {}): AlertQuota => ({
    provider: "codex-cli",
    level: "ok",
    reason: null,
    resumeAt: null,
    windowRequests: 3,
    hardRequests: 10,
    windowHours: 5,
    notifiedLevel: null,
    ...over,
  });
  const input = (providers: AlertQuota[], notifyRecovery = true): AlertQuotaInput => ({ providers, notifyRecovery, now: NOW, timeZone: "Europe/Berlin" });
  const quotaKinds = (q: AlertQuotaInput) => kinds({ aiQuota: q });

  it("alerts once when a window cap starts, with the count and the local resume time", () => {
    const hard = quota({ level: "hard", reason: "window", windowRequests: 10, resumeAt: new Date("2026-10-07T12:30:00Z") });
    const [alert] = buildAlerts({ ...empty, aiQuota: input([hard]) }, ZH);
    expect(alert).toMatchObject({ kind: "quota_hard", key: "codex-cli", quota: { provider: "codex-cli", level: "hard" } });
    expect(alert?.title).toContain("codex-cli");
    expect(alert?.detail).toContain("14:30"); // Berlin
    expect(alert?.detail).toContain("10");
    // the same state, already announced: nothing, however long it lasts
    expect(quotaKinds(input([{ ...hard, notifiedLevel: "hard" }]))).toEqual([]);
  });

  it("alerts once for a limit the provider reported (the cooldown)", () => {
    expect(quotaKinds(input([quota({ level: "hard", reason: "error", resumeAt: new Date("2026-10-07T11:00:00Z") })]))).toEqual(["quota_cooldown:codex-cli"]);
  });

  it("sends one recovery message when notify_recovery is on, and marks it silently when off", () => {
    const back = quota({ level: "ok", notifiedLevel: "hard" });
    expect(quotaKinds(input([back]))).toEqual(["quota_recovered:codex-cli"]);
    expect(quotaKinds(input([{ ...back, notifiedLevel: "ok" }]))).toEqual([]);
    expect(quotaKinds(input([back], false))).toEqual([]);
    expect(silentQuotaRecoveries(input([back], false))).toEqual([{ provider: "codex-cli", level: "ok" }]);
    expect(silentQuotaRecoveries(input([back], true))).toEqual([]);
  });

  it("says nothing for a provider that was never capped", () => {
    expect(quotaKinds(input([quota(), quota({ provider: "claude-cli" })]))).toEqual([]);
  });
});

describe("aiQuotaHoldOf", () => {
  it("finds the cap in a skipped step, a skipped sub-task or a scoring run that stopped, earliest time first", () => {
    expect(aiQuotaHoldOf({ subtasks: [], skipped: "quota_guard", resumeAt: "2026-10-07T12:00:00.000Z" })).toEqual({ resumeAt: new Date("2026-10-07T12:00:00.000Z"), heldJobIds: null });
    expect(aiQuotaHoldOf({ subtasks: [{ name: "translate", status: "skipped", reason: "quota_guard", resumeAt: null }] })).toEqual({ resumeAt: null, heldJobIds: null });
    expect(
      aiQuotaHoldOf({
        subtasks: [
          { name: "score", status: "ok", result: { scored: 3, stopped: "quota_guard", quotaResumeAt: "2026-10-07T13:00:00.000Z", quotaHeldJobIds: [7, 8] } },
          { name: "signals", status: "skipped", reason: "quota_guard", resumeAt: "2026-10-07T12:00:00.000Z" },
        ],
      }),
    ).toEqual({ resumeAt: new Date("2026-10-07T12:00:00.000Z"), heldJobIds: new Set([7, 8]) });
  });

  it("names no held job when the scoring finished and only a later sub-task was capped (per_cycle_limit left the rest)", () => {
    expect(
      aiQuotaHoldOf({
        subtasks: [
          { name: "score", status: "ok", result: { scored: 80 } },
          { name: "translate", status: "skipped", reason: "quota_guard", resumeAt: null },
        ],
      }),
    ).toEqual({ resumeAt: null, heldJobIds: new Set() });
  });

  it("is null when the cap played no part or the result is unexpected", () => {
    expect(aiQuotaHoldOf({ subtasks: [{ name: "score", status: "ok", result: { scored: 3 } }], skipped: "no_provider_available" })).toBeNull();
    expect(aiQuotaHoldOf(undefined)).toBeNull();
    expect(aiQuotaHoldOf("nonsense")).toBeNull();
  });
});

describe("dedupeAlerts per kind", () => {
  const now = new Date("2026-10-07T10:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const alert = (kind: string, key: string) => ({ kind, key, title: "t", detail: "d" });

  it("a kind with its own window uses it; every other kind keeps the general window", () => {
    const sent = [
      { kind: "quota_hard", key: "codex-cli", sentAt: hoursAgo(7) },
      { kind: "circuit_open", key: "a", sentAt: hoursAgo(7) },
    ];
    const result = dedupeAlerts([alert("quota_hard", "codex-cli"), alert("circuit_open", "a")], sent, { now, windowHours: 24, windowHoursByKind: { quota_hard: 6 } });
    expect(result.map((a) => a.kind)).toEqual(["quota_hard"]);
    expect(dedupeAlerts([alert("circuit_open", "a")], sent, { now, windowHours: 24 })).toEqual([]);
  });
});
