// @vitest-environment node
import { expect, it } from "vitest";
import { toCycleDto, toDoctorDto } from "@/lib/mcp/dto/ops";
import { mcpTranslator } from "@/lib/mcp/text";
import { runDoctor } from "@/lib/ops/doctor/run";
import { makeContext } from "../ops/doctor/helpers";

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
