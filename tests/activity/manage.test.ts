// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityDeleteExecuteSchema, activityDeleteInputSchema, executeDelete, previewDelete, resolveActivityDeleteScope } from "@/lib/activity/manage";
import type { Db } from "@/lib/db";
import { activitySettings } from "./helpers";

vi.mock("@/lib/db", () => ({ activityTablesReady: vi.fn(), deleteActivityBatch: vi.fn(), previewActivityDelete: vi.fn() }));
vi.mock("@/lib/config", () => ({ loadConfig: vi.fn() }));
import { activityTablesReady, deleteActivityBatch, previewActivityDelete } from "@/lib/db";
import { loadConfig } from "@/lib/config";
const db = {} as Db;
afterEach(() => vi.resetAllMocks());

function ready() {
  vi.mocked(activityTablesReady).mockResolvedValue(true);
  const settings = activitySettings();
  vi.mocked(loadConfig).mockImplementation(((name: string) => name === "activityLog" ? settings : { timezone: "Europe/Paris" }) as typeof loadConfig);
  return settings;
}

describe("activity deletion input", () => {
  it.each([
    { scope: "all" }, { scope: "root", rootId: "123e4567-e89b-42d3-a456-426614174000" },
    { scope: "range", to: "2026-02-28" }, { scope: "range", from: "2026-02-28", to: "2026-02-28" },
    { scope: "range", to: "2024-02-29" },
  ])("accepts valid scopes: $scope", (input) => { expect(activityDeleteInputSchema.safeParse(input).success).toBe(true); });
  it.each([
    null, {}, { scope: "root", rootId: "secret" }, { scope: "range", to: "2026-02-29" }, { scope: "range", to: "2026-13-01" },
    { scope: "range", to: "2026-00-00" }, { scope: "range", to: "2026-1-1" }, { scope: "range", from: "2026-03-02", to: "2026-03-01" },
    { scope: "all", from: "2026-01-01" }, { scope: "range", from: "", to: "2026-01-01" },
  ])("rejects invalid/unexpected input %#", (input) => { expect(activityDeleteInputSchema.safeParse(input).success).toBe(false); });
  it("requires an ISO instant on execution", () => {
    expect(activityDeleteExecuteSchema.safeParse({ scope: "all" }).success).toBe(false);
    expect(activityDeleteExecuteSchema.safeParse({ scope: "all", asOf: "2026-10-20" }).success).toBe(false);
    expect(activityDeleteExecuteSchema.safeParse({ scope: "all", asOf: "2026-10-20T12:00:00Z" }).success).toBe(true);
  });
  it.each([
    ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
  ])("converts inclusive zone days across DST: %s", (day, from, to) => {
    expect(resolveActivityDeleteScope({ scope: "range", from: day, to: day }, "Europe/Paris")).toEqual({ kind: "range", from: new Date(from), to: new Date(to) });
  });
  it("supports an unbounded start and zones with fractional offsets", () => {
    expect(resolveActivityDeleteScope({ scope: "range", to: "2026-01-01" }, "Asia/Kathmandu")).toEqual({ kind: "range", from: null, to: new Date("2026-01-01T18:15:00Z") });
  });
  it("passes non-range scopes through", () => {
    expect(resolveActivityDeleteScope({ scope: "all" }, "UTC")).toEqual({ kind: "all" });
    expect(resolveActivityDeleteScope({ scope: "root", rootId: "id" }, "UTC")).toEqual({ kind: "root", rootId: "id" });
  });
});
describe("activity delete service", () => {
  it("checks readiness first and returns only a code when tables are unavailable", async () => {
    vi.mocked(activityTablesReady).mockResolvedValue(false);
    expect(await previewDelete(db, null)).toEqual({ status: "not_ready" });
    expect(await executeDelete(db, null)).toEqual({ status: "not_ready" });
    expect(loadConfig).not.toHaveBeenCalled();
  });
  it("returns invalid without loading config or mutating data", async () => {
    ready();
    expect(await previewDelete(db, null)).toEqual({ status: "invalid" });
    expect(await executeDelete(db, { scope: "all" })).toEqual({ status: "invalid" });
    expect(loadConfig).not.toHaveBeenCalled();
  });
  it("returns the DB cutoff and counts and converts the configured-zone range", async () => {
    ready();
    const asOf = new Date("2026-03-30T12:00:00Z");
    vi.mocked(previewActivityDelete).mockResolvedValue({ asOf, roots: 2, events: 3, skippedActive: 1 });
    expect(await previewDelete(db, { scope: "range", to: "2026-03-29" })).toEqual({ status: "ok", asOf: asOf.toISOString(), roots: 2, events: 3, skippedActive: 1 });
    expect(previewActivityDelete).toHaveBeenCalledWith(db, { kind: "range", from: null, to: new Date("2026-03-29T22:00:00Z") }, { staleAfterSeconds: 60, startupGraceSeconds: 30 });
  });
  it("batches until exhausted using configured batch size", async () => {
    const settings = ready();
    vi.mocked(deleteActivityBatch).mockResolvedValueOnce({ roots: 0, events: 2, found: true }).mockResolvedValueOnce({ roots: 1, events: 0, found: true }).mockResolvedValueOnce({ roots: 0, events: 0, found: false });
    expect(await executeDelete(db, { scope: "all", asOf: "2026-10-20T12:00:00Z" })).toEqual({ status: "done", roots: 1, events: 2 });
    expect(deleteActivityBatch).toHaveBeenCalledTimes(3);
    expect(deleteActivityBatch).toHaveBeenCalledWith(db, expect.objectContaining({ batchSize: settings.prune.batch_size, asOf: new Date("2026-10-20T12:00:00Z") }));
  });
  it("returns partial at the budget and can resume using the same cutoff", async () => {
    const settings = ready(); settings.ui.delete_budget_ms = 1;
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(2);
    vi.mocked(deleteActivityBatch).mockResolvedValueOnce({ roots: 0, events: 1, found: true }).mockResolvedValueOnce({ roots: 1, events: 0, found: true }).mockResolvedValueOnce({ roots: 0, events: 0, found: false });
    const input = { scope: "all", asOf: "2026-10-20T12:00:00Z" };
    expect(await executeDelete(db, input)).toEqual({ status: "partial", roots: 0, events: 1 });
    clock.mockReturnValue(2);
    expect(await executeDelete(db, input)).toEqual({ status: "done", roots: 1, events: 0 });
    clock.mockRestore();
  });
  it("propagates operational errors for the action to log", async () => {
    ready(); vi.mocked(previewActivityDelete).mockRejectedValue(new Error("db unavailable"));
    await expect(previewDelete(db, { scope: "all" })).rejects.toThrow("db unavailable");
  });
});
