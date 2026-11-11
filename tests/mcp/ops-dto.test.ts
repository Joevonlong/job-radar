// @vitest-environment node
import { expect, it } from "vitest";
import type { ActivityRootRow, ActivitySpanRow, ActivityEventRow } from "@/lib/db/queries/activity";
import type { AiUsageGroup } from "@/lib/db/queries/ai-usage";
import type { Cycle } from "@/lib/db/repos/cycles";
import type { Run } from "@/lib/db/repos/runs";
import type { SourceCard } from "@/lib/sources/view";
import { activityLogOutput, listChannelsOutput, listCyclesOutput, toActivityRootDto, toActivitySpanDto, toActivityEventDto, toAiUsageDto, toChannelDto, toCycleDto, toDoctorDto, toRunDto } from "@/lib/mcp/dto/ops";
import { mcpTranslator } from "@/lib/mcp/text";
import { runDoctor } from "@/lib/ops/doctor/run";
import { makeContext } from "../ops/doctor/helpers";

const at = new Date("2026-01-01T00:00:00Z");
const id = "00000000-0000-4000-8000-000000000001";
const knownModelIds = new Set(["example-model", "alpha-model", "zeta-model"]);
const usageGroup = (overrides: Partial<AiUsageGroup> = {}): AiUsageGroup => ({
  day: "2026-01-01", provider: "anthropic", model: "example-model", modelSource: null, task: "score", outcome: "ok",
  calls: 1, tokenCalls: 0, tokensIn: 0, tokensInCached: 0, cachedCalls: 0, tokensInCacheWrite: 0, tokensOut: 0,
  tokensOutReasoning: 0, reasoningCalls: 0, durationMsSum: 0, durationCalls: 0, equivalentUsd: 0, equivalentCalls: 0,
  actualUsd: 0, actualCalls: 0, actualUsdWithEquivalent: 0, ...overrides,
});

it.each([
  ["host", "private-db-host"], ["path", "private/resume"], ["token", "sk-ops-sentinel123"],
  ["URL", "https://private.example/x"], ["oversized name", "x".repeat(300)],
])("withholds an unknown model containing a %s independently", (_kind, model) => {
  const output = toAiUsageDto([usageGroup({ model })], knownModelIds);
  expect(output.by_model).toMatchObject([{ provider: "anthropic", model: null, calls: 1 }]);
  expect(JSON.stringify(output)).not.toContain(model);
});

it("retains a trusted model id even when the stored provider is unknown", () => {
  for (const provider of ["anthropic", "unrecognized-provider"]) {
    expect(toAiUsageDto([usageGroup({ provider })], knownModelIds).by_model).toMatchObject([
      { provider: provider === "anthropic" ? provider : "unknown", model: "example-model" },
    ]);
  }
});

it("withholds every model when the catalog supplies no trusted ids", () => {
  const output = toAiUsageDto([usageGroup()], new Set());
  expect(output.by_model[0]?.model).toBeNull();
  expect(JSON.stringify(output)).not.toContain("example-model");
});

it("puts newest days and largest groups first, with alphabetical ties", () => {
  const output = toAiUsageDto([
    usageGroup({ day: "2026-01-01", task: "probe", model: "alpha-model" }),
    usageGroup({ day: "2026-01-02", task: "translate", model: "zeta-model", calls: 6 }),
    usageGroup({ day: "2026-01-03", task: "score", model: "example-model", calls: 6 }),
  ], knownModelIds);
  const limit = 2;
  const byDay = output.by_day.slice(0, limit);
  expect(byDay.map((row) => row.day)).toEqual(["2026-01-03", "2026-01-02"]);
  expect(byDay.some((row) => row.day === "2026-01-01")).toBe(false);
  expect(output.by_day.length > limit).toBe(true);
  expect(output.by_task.slice(0, limit).map((row) => row.task)).toEqual(["score", "translate"]);
  expect(output.by_model.slice(0, limit).map((row) => row.model)).toEqual(["example-model", "zeta-model"]);
  expect(output.totals.calls).toBe(13);
});

it("maps unexpected cycle kinds and statuses to unknown", () => {
  const row: Cycle = { id: 1, kind: "manual", status: "succeeded", startedAt: at, finishedAt: null, summaryJson: null };
  Object.assign(row, { kind: "future-kind", status: "future-status" });
  expect(listCyclesOutput.shape.cycles.element.parse(toCycleDto(row))).toMatchObject({ kind: "unknown", status: "unknown" });
});

it("maps unexpected run channels and statuses to unknown", () => {
  const row = { id: 1, channelId: "future-channel", startedAt: at, finishedAt: null, status: "future-status", fetched: 0,
    newCount: 0, interrupted: false, usageUnits: 0, windowHours: null, windowExtended: false, error: null, errorCode: null } as unknown as Run;
  expect(listCyclesOutput.shape.expanded.unwrap().shape.runs.element.parse(toRunDto(row))).toMatchObject({ channel_id: "unknown", status: "unknown" });
});

it("maps unexpected channel health, breaker and latest-run status to unknown", () => {
  const row = { id: "future-channel", enabled: true, registered: true, status: "future-health",
    circuit: { state: "future-breaker", openUntil: null, consecutiveFailures: 0, lastErrorCode: null },
    usage: { records: 0, usd: 0, budgetUsd: 0, freeRecords: 0 },
    runs: [{ id: 1, status: "future-status", startedAt: at, finishedAt: null, fetched: 0, newCount: 0, interrupted: false, error: null, errorCode: null }],
  } as unknown as SourceCard;
  expect(listChannelsOutput.shape.channels.element.parse(toChannelDto(row))).toMatchObject({
    id: "unknown", health: "unknown", breaker: { state: "unknown" }, latest_run: { status: "unknown" },
  });
});

it("maps unexpected activity root scope, name and status to unknown", () => {
  const row = { id, scope: "future-scope", name: "future-name", status: "future-status", startedAt: at, finishedAt: null,
    active: false, progressDone: null, progressTotal: null, failedChildren: 0, warnEvents: 0, errorEvents: 0,
    eventsDropped: 0, reasonCode: null, request: null } as unknown as ActivityRootRow;
  expect(activityLogOutput.shape.roots.element.parse(toActivityRootDto(row))).toMatchObject({ scope: "unknown", name: "unknown", status: "unknown" });
});

it("maps unexpected activity span names and statuses to unknown", () => {
  const row = { id, parentId: null, name: "future-name", status: "future-status", progressDone: null, progressTotal: null,
    eventsDropped: 0, reasonCode: null } as unknown as ActivitySpanRow;
  expect(activityLogOutput.shape.detail.unwrap().shape.spans.element.parse(toActivitySpanDto(row))).toMatchObject({ name: "unknown", status: "unknown" });
});

it("maps unexpected activity event levels and codes to unknown", () => {
  const row = { id, spanId: id, level: "future-level", code: "future-code", params: {} } as unknown as ActivityEventRow;
  expect(activityLogOutput.shape.detail.unwrap().shape.events.element.parse(toActivityEventDto(row))).toMatchObject({ level: "unknown", code: "unknown" });
});

it("maps actual doctor failures and warnings to fixed localized summaries without probe details", async () => {
  const secret = "/tmp/private-doctor https://private.invalid postgres://private@db.invalid/private com.private.worker";
  const report = await runDoctor(makeContext(), [
    { id: "backup.recent", group: "data", run: async () => { throw new Error(secret); } },
    { id: "aiworker.launchd", group: "processes", run: async () => ({ id: "aiworker.launchd", group: "processes", status: "warn", title: secret, detail: secret, hint: secret }) },
    { id: "db.connect", group: "stack", run: async () => ({ id: "db.connect", group: "stack", status: "ok", detail: secret }) },
  ]);
  for (const locale of ["en", "zh"] as const) {
    const text = mcpTranslator(locale);
    const output = toDoctorDto(report, text);
    expect(output.checks).toHaveLength(3);
    for (const check of output.checks) {
      expect(Object.keys(check)).toEqual(["id", "status", "summary"]);
      expect(check.summary).toBe(text(`ops.checkSummary.${check.status}`));
    }
    expect(JSON.stringify(output)).not.toMatch(/private|postgres:|https:|\/tmp\//);
  }
});

it("keeps normal notification and AI counters when their results contain nonnumeric skip metadata", () => {
  const row = { id: 1, kind: "manual" as const, status: "succeeded" as const, startedAt: new Date("2026-01-01T00:00:00Z"), finishedAt: null,
    summaryJson: { steps: [
      { name: "notify", status: "ok", result: { jobs: { newJobs: 8, passedFilter: 6, qualified: 4, pushed: 3, overflow: 1, failed: 0, skipped: { alreadyNotified: 2, filteredOut: 1, unscored: 1, belowThreshold: 0 } } } },
      { name: "ai", status: "partial", result: { subtasks: [{ result: { scored: 5, failed: 1 } }, { result: { translated: 2, skipped: "quota_guard" } }] } },
    ] },
  };
  expect(toCycleDto(row).steps).toEqual([
    { name: "notify", status: "ok", counts: { newJobs: 8, passedFilter: 6, qualified: 4, pushed: 3, overflow: 1, failed: 0 } },
    { name: "ai", status: "partial", counts: { scored: 5, failed: 1, translated: 2 } },
  ]);
});

it("summarizes actual signal, reply and maintenance results through named count fields", () => {
  const steps = [
    { name: "signals", status: "ok", result: { scan: { scanned: 8, withSignals: 3, signals: 5, failed: 0 }, salary: { synced: 2, failed: 0 }, bonus: { updated: 3 }, revalued: { updated: 4 }, traps: { scanned: 8 }, visa: { scanned: 7 }, ghost: { scanned: 6 } } },
    { name: "replies", status: "ok", result: { fresh: 4, read: 3, stored: 2, oversized: 1, ownSkipped: 1, failed: 0, cleared: 5, categories: { rejection: 1 }, private: "/tmp/private" } },
    { name: "maintenance", status: "ok", result: { seen: 10, reopened: 2, relisted: 1, possiblyClosed: 3, linkChecked: 4, closed: 2, alive: 2, unseen: { closed: 2, alive: 2 } } },
  ];
  expect(toCycleDto({ id: 1, kind: "manual", status: "succeeded", startedAt: new Date(), finishedAt: null, summaryJson: { steps } }).steps.map((step) => step.counts)).toEqual([
    { scanned: 8, withSignals: 3, signals: 5, failed: 0, salarySynced: 2, bonusUpdated: 3, revalued: 4, trapsScanned: 8, visaScanned: 7, ghostScanned: 6 },
    { fresh: 4, read: 3, stored: 2, oversized: 1, ownSkipped: 1, failed: 0, cleared: 5 },
    { seen: 10, reopened: 2, relisted: 1, possiblyClosed: 3, linkChecked: 4, closed: 2, alive: 2 },
  ]);
});
