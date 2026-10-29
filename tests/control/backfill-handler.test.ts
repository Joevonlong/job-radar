// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import { loadConfig } from "@/lib/config";
import { runCycleHandler } from "@/lib/control/handlers";
import type { ControlHandlerContext } from "@/lib/control/types";
import { runCycle, type CycleRunResult } from "@/lib/cycle/run-cycle";
import type { Db } from "@/lib/db/client";
import type { ControlRequest } from "@/lib/db/repos/control-requests";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";

vi.mock("@/lib/cycle/run-cycle", () => ({ runCycle: vi.fn() }));

let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig();
  vi.mocked(runCycle).mockReset();
});
afterEach(() => { temp.cleanup(); });

const context = (): ControlHandlerContext => ({ db: {} as Db, signal: new AbortController().signal, logger: quietLogger });
const request = (payload: unknown): ControlRequest => ({
  id: 1, kind: "run_cycle", payload, status: "running", result: null,
  requestedAt: new Date(), startedAt: new Date(), finishedAt: null,
});

function cycleResult(status: CycleRunResult["status"], backfillHours?: number): CycleRunResult {
  return {
    cycleId: 5, kind: "manual", status, results: {}, summary: {
      version: 1, kind: "manual", windowKind: null, channelIds: ["indeed"], dryRun: false,
      startedAt: new Date().toISOString(), durationMs: 10, aborted: false, steps: [],
      ...(status === "skipped" ? { coveredBy: 4 } : {}),
      ...(backfillHours === undefined ? {} : { backfillHours }),
    },
  };
}

describe("manual backfill handler", () => {
  it("refreshes a cached limit and refuses before calling runCycle", async () => {
    expect(loadConfig("channels").collect.max_backfill_hours).toBe(168);
    const file = path.join(temp.configDir, "sources.yaml");
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    doc.setIn(["collect", "max_backfill_hours"], 24);
    fs.writeFileSync(file, doc.toString());
    expect(await runCycleHandler(request({ backfillHours: 36 }), context())).toEqual({
      status: "failed", result: { error: "backfill_over_limit", backfillHours: 36, maxBackfillHours: 24 },
    });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it("passes the backfill and channel selection through and reports the requested hours", async () => {
    vi.mocked(runCycle).mockResolvedValue(cycleResult("succeeded", 36));
    const ctx = context();
    expect(await runCycleHandler(request({ backfillHours: 36, channelIds: ["indeed"] }), ctx)).toEqual({
      status: "done", result: { cycleId: 5, cycleStatus: "succeeded", durationMs: 10, backfillHours: 36 },
    });
    expect(runCycle).toHaveBeenCalledExactlyOnceWith("manual", { ...ctx, backfillHours: 36, channelIds: ["indeed"] });
  });

  it.each([undefined, 36])("handles a covering cycle with backfillHours=%s", async (backfillHours) => {
    vi.mocked(runCycle).mockResolvedValue(cycleResult("skipped", backfillHours));
    const outcome = await runCycleHandler(request(backfillHours === undefined ? {} : { backfillHours }), context());
    expect(outcome).toEqual(backfillHours === undefined
      ? { status: "done", result: { cycleId: 4, cycleStatus: "running", durationMs: 10, coveredBy: 4, skippedCycleId: 5 } }
      : { status: "failed", result: { cycleId: 5, cycleStatus: "skipped", durationMs: 10, backfillHours, coveredBy: 4, error: "another_cycle_running" } });
    if (backfillHours === undefined) expect(vi.mocked(runCycle).mock.calls[0]![1]).not.toHaveProperty("backfillHours");
  });
});
