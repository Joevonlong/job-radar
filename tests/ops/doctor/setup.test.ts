// @vitest-environment node
import { describe, expect, it } from "vitest";

import { lastCycleCheck } from "@/lib/ops/doctor/checks/schedule";
import { setupCompletedCheck } from "@/lib/ops/doctor/checks/setup";
import type { SetupStatus } from "@/lib/setup/state";

import { makeContext, only, sourcesView } from "./helpers";

const status = (extra: Partial<SetupStatus>): SetupStatus => ({ pending: false, state: null, error: null, source: "user", path: "/u/setup.yaml", ...extra });
const withSetup = (setup: SetupStatus, overrides: Parameters<typeof makeContext>[0] = {}) => makeContext({ ...overrides, probes: { setup: async () => setup, ...overrides.probes } });

describe("setup.completed", () => {
  it("ok once completed, naming when and how", async () => {
    const r = await only(setupCompletedCheck, withSetup(status({ state: { completed_at: "2026-10-01T08:00:00.000Z", completed_by: "wizard", steps: {} } })));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("2026-10-01T08:00:00.000Z");
  });

  it("ok for an install from before the wizard", async () => {
    expect((await only(setupCompletedCheck, withSetup(status({ source: "existing_install", path: null })))).status).toBe("ok");
  });

  it("warns while pending, pointing at /setup and pnpm run setup", async () => {
    const r = await only(setupCompletedCheck, withSetup(status({ pending: true, state: { completed_at: null, completed_by: null, steps: {} } })));
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("/setup");
    expect(r.hint).toContain("pnpm run setup");
  });

  it("fails on an invalid setup.yaml", async () => {
    const r = await only(setupCompletedCheck, withSetup(status({ error: "completed_by: Invalid option" })));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("completed_by: Invalid option");
  });

  it("reports in the command-line language", async () => {
    const pending = status({ pending: true, state: { completed_at: null, completed_by: null, steps: {} } });
    const en = await only(setupCompletedCheck, withSetup(pending, { locale: "en" }));
    const zh = await only(setupCompletedCheck, withSetup(pending, { locale: "zh" }));
    expect(en.detail).toMatch(/not finished/);
    expect(zh.detail).toContain("首次设置");
  });
});

describe("cycle.last while the setup is pending", () => {
  it("is not a failure that no cycle ran yet: the cycles wait for the setup", async () => {
    const r = await only(lastCycleCheck, withSetup(status({ pending: true }), { probes: { sources: async () => sourcesView({ latestCycle: null }) } }));
    expect(r.status).toBe("ok");
  });

  it("does not report missed slots while pending", async () => {
    const latestCycle = { id: 1, kind: "manual" as const, status: "succeeded" as const, startedAt: new Date("2026-10-01T05:00:00Z"), finishedAt: new Date("2026-10-01T05:05:00Z"), channels: [] };
    const pending = await only(lastCycleCheck, withSetup(status({ pending: true }), { probes: { sources: async () => sourcesView({ latestCycle }) } }));
    expect(pending.status).toBe("ok");
    const done = await only(lastCycleCheck, withSetup(status({}), { probes: { sources: async () => sourcesView({ latestCycle }) } }));
    expect(done.status).toBe("fail");
  });
});
