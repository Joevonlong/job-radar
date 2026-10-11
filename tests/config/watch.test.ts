// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, watchConfig, writeConfig, type ConfigChangeEvent, type ConfigError } from "@/lib/config";

import { makeTempConfig, sleep, waitFor, type TempConfig } from "./helpers";

/** Real OS file events can be late on a loaded machine; the deadline only ends a hang. */
const REAL_EVENT_DEADLINE_MS = 20_000;

let tmp: TempConfig;
const unsubscribers: Array<() => void> = [];
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => {
  vi.useRealTimers();
  while (unsubscribers.length > 0) unsubscribers.pop()?.();
  tmp.cleanup();
});

function start(options: Parameters<typeof watchConfig>[2]) {
  const events: ConfigChangeEvent[] = [];
  const errors: ConfigError[] = [];
  const stop = watchConfig("all", (e) => events.push(e), { ...options, onError: (e) => errors.push(e) });
  unsubscribers.push(stop);
  return { events, errors, stop };
}

/** Real fs.watch: give the OS watcher a moment to become active (macOS can miss events from the first few ms). */
async function setupReal(options: Parameters<typeof watchConfig>[2]) {
  const watcher = start(options);
  await sleep(150);
  return watcher;
}

/**
 * Polling only, on fake timers: no OS events and no wall clock, so the result does not depend on machine load.
 * `tick(ms)` moves the clock, which runs the debounce and poll timers due in that span.
 */
function setupFake(options: Parameters<typeof watchConfig>[2]) {
  vi.useFakeTimers();
  const watcher = start({ ...options, fsWatch: false });
  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { ...watcher, tick };
}

function edit(name: string, from: string, to: string): void {
  const file = path.join(tmp.configDir, name);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(from, to));
}

describe("watchConfig (polling fallback)", () => {
  const options = { debounceMs: 50, pollMs: 100 };

  it("picks up a change within 2 seconds", async () => {
    loadConfig("schedule");
    const { events, errors, tick } = setupFake(options);
    edit("schedule.yaml", '"0 7 * * 1-5"', '"30 6 * * 1-5"');
    await tick(2000);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.name).toBe("schedule");
    expect(event?.filePath).toBe(path.join(tmp.configDir, "schedule.yaml"));
    expect((event?.value as { cycles: { weekday_morning: { cron: string } } }).cycles.weekday_morning.cron).toBe("30 6 * * 1-5");
    expect(loadConfig("schedule").cycles.weekday_morning.cron).toBe("30 6 * * 1-5");
    expect(errors).toHaveLength(0);
  });

  it("keeps the old value on invalid content, reports it once, and recovers", async () => {
    const before = loadConfig("notify");
    const { events, errors, tick } = setupFake(options);
    edit("notify.yaml", "push_min_score: 70", "push_min_score: -4");
    await tick(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.configName).toBe("notify");
    expect(errors[0]?.issues.map((i) => i.path)).toContain("push_min_score");
    expect(events).toHaveLength(0);
    expect(loadConfig("notify").push_min_score).toBe(before.push_min_score);

    await tick(2000);
    expect(errors).toHaveLength(1); // same bad content is not reported again

    edit("notify.yaml", "push_min_score: -4", "push_min_score: 65");
    await tick(500);
    expect(events).toHaveLength(1);
    expect(loadConfig("notify").push_min_score).toBe(65);
  });

  it("reports broken YAML without throwing out of the watcher", async () => {
    loadConfig("search");
    const { errors, tick } = setupFake(options);
    fs.writeFileSync(path.join(tmp.configDir, "search.yaml"), "locations: [Berlin\n");
    await tick(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("yaml");
  });

  it("stops after unsubscribe", async () => {
    const { events, stop, tick } = setupFake(options);
    stop();
    edit("schedule.yaml", '"0 7 * * 1-5"', '"15 7 * * 1-5"');
    await tick(2000);
    expect(events).toHaveLength(0);
  });

  it("notices a file that appears later (profile created after start)", async () => {
    const { events, tick } = setupFake(options);
    fs.mkdirSync(tmp.profileDir, { recursive: true });
    fs.copyFileSync(path.join(tmp.defaultsDir, "profile.example", "me.yaml"), path.join(tmp.profileDir, "me.yaml"));
    await tick(2000);
    expect(events.some((e) => e.name === "me")).toBe(true);
  });

  it("reports a deleted file once and keeps the cached value", async () => {
    // Only when neither layer has it (the user file gone falls back to the default, see the layers suite)
    fs.rmSync(path.join(tmp.defaultsDir, "ai.yaml"));
    loadConfig("ai");
    const { errors, tick } = setupFake({ debounceMs: 20, pollMs: 80 });
    fs.rmSync(path.join(tmp.configDir, "ai.yaml"));
    await tick(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("missing");
    await tick(2000);
    expect(errors).toHaveLength(1);
    expect(loadConfig("ai").per_cycle_limit).toBe(80);
  });

  it("survives a throwing onChange callback", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    unsubscribers.push(
      watchConfig(
        "schedule",
        () => {
          seen.push("called");
          throw new Error("boom");
        },
        { debounceMs: 20, pollMs: 80, fsWatch: false },
      ),
    );
    edit("schedule.yaml", '"0 7 * * 1-5"', '"1 7 * * 1-5"');
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual(["called"]);
  });

  it("fires for in-process writeConfig too", async () => {
    const schedule = loadConfig("schedule");
    const { events, tick } = setupFake({ debounceMs: 20, pollMs: 80 });
    await writeConfig("schedule", { ...schedule, catch_up: false });
    await tick(500);
    expect(events.some((e) => e.name === "schedule")).toBe(true);
  });

  it("reads the poll interval from JOB_RADAR_CONFIG_POLL_MS", async () => {
    process.env.JOB_RADAR_CONFIG_POLL_MS = "60";
    const { events, tick } = setupFake({ debounceMs: 20 });
    edit("schedule.yaml", '"0 7 * * 1-5"', '"2 7 * * 1-5"');
    await tick(59);
    expect(events).toHaveLength(0); // before the first poll tick
    await tick(100);
    expect(events).toHaveLength(1);
  });
});

// The only tests that need the real file system watcher: they wait for events, never for a fixed time.
describe("watchConfig (fs.watch, real OS events)", () => {
  const options = { debounceMs: 50, pollMs: 0, fsWatch: true };

  it("picks up a change", async () => {
    loadConfig("schedule");
    const { events, errors } = await setupReal(options);
    edit("schedule.yaml", '"0 7 * * 1-5"', '"30 6 * * 1-5"');
    expect(await waitFor(() => events.length > 0, REAL_EVENT_DEADLINE_MS)).toBe(true);
    const event = events[0];
    expect(event?.name).toBe("schedule");
    expect(event?.filePath).toBe(path.join(tmp.configDir, "schedule.yaml"));
    expect((event?.value as { cycles: { weekday_morning: { cron: string } } }).cycles.weekday_morning.cron).toBe("30 6 * * 1-5");
    expect(loadConfig("schedule").cycles.weekday_morning.cron).toBe("30 6 * * 1-5");
    expect(errors).toHaveLength(0);
  });

  it("keeps the old value on invalid content, reports it once, and recovers", async () => {
    const before = loadConfig("notify");
    const { events, errors } = await setupReal(options);
    edit("notify.yaml", "push_min_score: 70", "push_min_score: -4");
    expect(await waitFor(() => errors.length > 0, REAL_EVENT_DEADLINE_MS)).toBe(true);
    expect(errors[0]?.configName).toBe("notify");
    expect(events).toHaveLength(0);
    expect(loadConfig("notify").push_min_score).toBe(before.push_min_score);

    edit("notify.yaml", "push_min_score: -4", "push_min_score: 65");
    expect(await waitFor(() => events.length > 0, REAL_EVENT_DEADLINE_MS)).toBe(true);
    expect(loadConfig("notify").push_min_score).toBe(65);
  });

  it("reports broken YAML without throwing out of the watcher", async () => {
    loadConfig("search");
    const { errors } = await setupReal(options);
    fs.writeFileSync(path.join(tmp.configDir, "search.yaml"), "locations: [Berlin\n");
    expect(await waitFor(() => errors.length > 0, REAL_EVENT_DEADLINE_MS)).toBe(true);
    expect(errors[0]?.kind).toBe("yaml");
  });

  it("stops after unsubscribe", async () => {
    const { events, stop } = await setupReal(options);
    stop();
    edit("schedule.yaml", '"0 7 * * 1-5"', '"15 7 * * 1-5"');
    await sleep(400); // a negative check: a late event could only make this pass too early, never fail it
    expect(events).toHaveLength(0);
  });
});
