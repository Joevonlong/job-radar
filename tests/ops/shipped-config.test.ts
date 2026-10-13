// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({ reportShippedConfig: vi.fn<(db: unknown, process: string, report: Record<string, unknown>) => Promise<void>>() }));
vi.mock("@/lib/db/repos/runtime-state", () => repo);
vi.mock("@/lib/db/client", () => ({ getDb: () => ({ fake: "db" }) }));
// The web's time limit per attempt: schedule.yaml doctor.probe_timeout_seconds (1 s here, the smallest it may be).
const schedule = vi.hoisted(() => ({ probeTimeoutSeconds: 1, reads: 0 }));
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...original,
    loadConfig: ((name: Parameters<typeof original.loadConfig>[0]) => {
      if (name !== "schedule") return original.loadConfig(name);
      schedule.reads += 1;
      const real = original.loadConfig("schedule");
      return { ...real, doctor: { ...real.doctor, probe_timeout_seconds: schedule.probeTimeoutSeconds } };
    }) as typeof original.loadConfig,
  };
});

import { shippedConfigId } from "@/lib/config/shipped-id";
import type { Db } from "@/lib/db/client";
import { createReportOnce, createShippedConfigReporter, reportWebShippedConfig, type ShippedConfigReporterOptions } from "@/lib/ops/shipped-config";

let root = "";
let dir = "";
let lines: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-report-"));
  dir = path.join(root, "config");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "schedule.yaml"), "timezone: Europe/Berlin\n");
  lines = [];
  repo.reportShippedConfig.mockReset();
  repo.reportShippedConfig.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const STARTED = new Date("2026-10-07T12:00:00.000Z");

function reporter(extra: Partial<ShippedConfigReporterOptions> = {}) {
  return createShippedConfigReporter({
    process: "runner",
    db: () => ({}) as Db,
    log: (message) => lines.push(message),
    dir: () => dir,
    pid: 4242,
    instance: "0123456789ab",
    startedAt: STARTED,
    ...extra,
  });
}

describe("createShippedConfigReporter", () => {
  it("writes the identity of the directory with the process facts, and logs the first success", async () => {
    const id = await shippedConfigId(dir);
    expect(await reporter().report()).toBe(true);
    expect(repo.reportShippedConfig).toHaveBeenCalledWith({}, "runner", { id, dir, instance: "0123456789ab", pid: 4242, startedAt: STARTED.toISOString() });
    expect(lines).toEqual([`shipped config ${dir} (${id.slice(0, 12)}) reported`]);
  });

  it("defaults to this process, the host name and the process start", async () => {
    await createShippedConfigReporter({ process: "web", db: () => ({}) as Db, log: () => undefined, dir: () => dir }).report();
    const report = repo.reportShippedConfig.mock.calls[0]?.[2];
    expect(report).toMatchObject({ pid: process.pid, instance: os.hostname() });
    expect(Date.parse(String(report?.startedAt))).toBeLessThanOrEqual(Date.now());
  });

  it("refreshes on every call (each heartbeat) and reads the directory again, logging only the first time", async () => {
    const r = reporter();
    await r.report();
    fs.writeFileSync(path.join(dir, "ai.yaml"), "execution: host\n");
    await r.report();
    await r.report();
    expect(repo.reportShippedConfig).toHaveBeenCalledTimes(3);
    const ids = repo.reportShippedConfig.mock.calls.map((call) => call[2].id);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[1]);
    expect(lines).toHaveLength(1);
  });

  it("never throws: a failed write is a warning, said once per kind of problem, and the recovery is logged", async () => {
    const r = reporter();
    repo.reportShippedConfig.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED postgres://user:secret@db/x"), { name: "DatabaseError" }));
    expect(await r.report()).toBe(false);
    expect(await r.report()).toBe(false);
    expect(lines).toEqual(["WARNING: could not report the shipped config: DatabaseError"]);
    expect(lines.join("\n")).not.toContain("secret");
    repo.reportShippedConfig.mockResolvedValue(undefined);
    expect(await r.report()).toBe(true);
    expect(lines[1]).toMatch(/^shipped config .+ reported$/);
    expect(await r.report()).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("names the problem of a directory that cannot be identified", async () => {
    expect(await reporter({ dir: () => path.join(root, "missing") }).report()).toBe(false);
    expect(lines).toEqual([`WARNING: could not report the shipped config: the shipped config directory does not exist: ${path.join(root, "missing")}`]);
    expect(repo.reportShippedConfig).not.toHaveBeenCalled();
  });

  it("gives up after the heartbeat's time limit", async () => {
    repo.reportShippedConfig.mockReturnValue(new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await reporter({ timeoutMs: () => 50 }).report()).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines[0]).toMatch(/^WARNING: could not report the shipped config: .*shipped config report/);
  });

  it("does not throw for a non-Error rejection", async () => {
    repo.reportShippedConfig.mockRejectedValue("boom");
    expect(await reporter().report()).toBe(false);
    expect(lines).toEqual(["WARNING: could not report the shipped config: unknown error"]);
  });
});

describe("createReportOnce (the web)", () => {
  it("retries on each call until one report worked, then stops writing", async () => {
    const report = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const once = createReportOnce({ report });
    expect(await once()).toBe(false);
    expect(await once()).toBe(false);
    expect(await once()).toBe(true);
    expect(await once()).toBe(true);
    expect(await once()).toBe(true);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("shares the attempt in flight between concurrent calls", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const report = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const once = createReportOnce({ report });
    const calls = [once(), once(), once()];
    expect(report).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await Promise.all(calls)).toEqual([true, true, true]);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("a bounded retry (the web's report)", () => {
  it("abandons an attempt that never settles after the time limit, and the next call retries", async () => {
    repo.reportShippedConfig.mockReturnValueOnce(new Promise<void>(() => undefined));
    const once = createReportOnce(reporter({ timeoutMs: () => 50 }));
    const first = once();
    expect(once()).toBe(first); // shared while in flight
    expect(await first).toBe(false);
    expect(lines[0]).toMatch(/^WARNING: could not report the shipped config: shipped config report did not finish/);
    expect(await once()).toBe(true);
    expect(repo.reportShippedConfig).toHaveBeenCalledTimes(2);
    expect(await once()).toBe(true);
    expect(repo.reportShippedConfig).toHaveBeenCalledTimes(2);
  });

  it("an unreadable time limit fails the attempt without leaving a write behind, and the next call retries", async () => {
    let calls = 0;
    const once = createReportOnce(
      reporter({
        timeoutMs: () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error("schedule.yaml: bad"), { name: "ConfigError" });
          return 20_000;
        },
      }),
    );
    expect(await once()).toBe(false);
    expect(repo.reportShippedConfig).not.toHaveBeenCalled();
    expect(lines).toEqual(["WARNING: could not report the shipped config: ConfigError"]);
    expect(await once()).toBe(true);
  });
});

describe("reportWebShippedConfig", () => {
  const key = Symbol.for("job-radar.shipped-config.web");
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[key];
  });

  it("keeps one state per server process (on globalThis), retrying until a write worked", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    repo.reportShippedConfig.mockRejectedValueOnce(new Error("down"));
    expect(await reportWebShippedConfig()).toBe(false);
    expect(await reportWebShippedConfig()).toBe(true);
    expect(await reportWebShippedConfig()).toBe(true);
    expect(repo.reportShippedConfig).toHaveBeenCalledTimes(2);
    expect(repo.reportShippedConfig.mock.calls[1]?.[1]).toBe("web");
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringMatching(/^\[config\] WARNING: could not report/), expect.stringMatching(/^\[config\] shipped config .+ reported$/)]);
    log.mockRestore();
  });

  it("gives up on a stuck write after doctor.probe_timeout_seconds, so a later health check writes again", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const readsBefore = schedule.reads;
    repo.reportShippedConfig.mockReturnValueOnce(new Promise<void>(() => undefined));
    expect(await reportWebShippedConfig()).toBe(false);
    expect(schedule.reads).toBeGreaterThan(readsBefore);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/did not finish within 1s/);
    expect(await reportWebShippedConfig()).toBe(true);
    expect(repo.reportShippedConfig).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
