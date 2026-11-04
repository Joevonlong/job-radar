// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, watchConfig, writeConfig, type ConfigChangeEvent, type ConfigError, type WatchDirectory } from "@/lib/config";

import { makeTempConfig, waitFor, type TempConfig } from "./helpers";

/** How long the system gets to deliver a real file event before the one test that needs it is skipped. */
const OS_DELIVERY_DEADLINE_MS = 25_000;
/** Our part once the system has delivered: debounce and one file read, on a machine that may be very busy. */
const AFTER_DELIVERY_DEADLINE_MS = 15_000;
const REAL_EVENT_TEST_TIMEOUT_MS = OS_DELIVERY_DEADLINE_MS + AFTER_DELIVERY_DEADLINE_MS + 5_000;

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

/**
 * Polling only, on fake timers: no OS events and no wall clock, so the result does not depend on machine load.
 * `tick(ms)` moves the clock, which runs the debounce and poll timers due in that span.
 */
function setupFake(options: Parameters<typeof watchConfig>[2]) {
  vi.useFakeTimers();
  const watcher = start({ fsWatch: false, ...options });
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
    loadConfig("ai");
    fs.rmSync(path.join(tmp.defaultsDir, "ai.yaml"));
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

/** A directory watcher the test fires by hand: the events are the test's, so nothing depends on when the system delivers its own. */
function fakeDirectories() {
  const watched = new Map<string, (filename: string | null) => void>();
  const unavailable = new Set<string>();
  const watchDirectory: WatchDirectory = (dir, onChange) => {
    if (unavailable.has(dir)) throw new Error("ENOENT");
    watched.set(dir, onChange);
    return { close: () => watched.delete(dir) };
  };
  return { watched, unavailable, watchDirectory };
}

describe("watchConfig (directory events)", () => {
  const debounceMs = 50;
  /** Directory events only, on fake timers; `fire` reports a change in the user directory. */
  function setup() {
    const directories = fakeDirectories();
    const watcher = setupFake({ debounceMs, pollMs: 0, fsWatch: true, watchDirectory: directories.watchDirectory });
    const fire = (filename: string | null) => directories.watched.get(tmp.configDir)?.(filename);
    return { ...watcher, ...directories, fire };
  }

  it("watches the user and the defaults directory", () => {
    const { watched } = setup();
    expect(watched.has(tmp.configDir)).toBe(true);
    expect(watched.has(tmp.defaultsDir)).toBe(true);
  });

  it("picks up a change an event names, after the debounce and only once for a burst of events", async () => {
    loadConfig("schedule");
    const { events, errors, fire, tick } = setup();
    edit("schedule.yaml", '"0 7 * * 1-5"', '"30 6 * * 1-5"');
    fire("schedule.yaml");
    await tick(debounceMs - 1);
    fire("schedule.yaml");
    await tick(debounceMs - 1);
    expect(events).toHaveLength(0);
    await tick(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("schedule");
    expect(events[0]?.filePath).toBe(path.join(tmp.configDir, "schedule.yaml"));
    expect(loadConfig("schedule").cycles.weekday_morning.cron).toBe("30 6 * * 1-5");
    expect(errors).toHaveLength(0);
  });

  it("does nothing for a file it does not know, and checks every file when the event names none", async () => {
    loadConfig("schedule");
    const { events, fire, tick } = setup();
    edit("schedule.yaml", '"0 7 * * 1-5"', '"30 6 * * 1-5"');
    fire("other.yaml");
    await tick(debounceMs * 2);
    expect(events).toHaveLength(0);
    fire(null);
    await tick(debounceMs * 2);
    expect(events.map((event) => event.name)).toEqual(["schedule"]);
  });

  it("keeps the old value on invalid content, reports it once, and recovers", async () => {
    const before = loadConfig("notify");
    const { events, errors, fire, tick } = setup();
    edit("notify.yaml", "push_min_score: 70", "push_min_score: -4");
    fire("notify.yaml");
    await tick(debounceMs);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.configName).toBe("notify");
    expect(events).toHaveLength(0);
    expect(loadConfig("notify").push_min_score).toBe(before.push_min_score);

    fire("notify.yaml");
    await tick(debounceMs);
    expect(errors).toHaveLength(1);

    edit("notify.yaml", "push_min_score: -4", "push_min_score: 65");
    fire("notify.yaml");
    await tick(debounceMs);
    expect(events).toHaveLength(1);
    expect(loadConfig("notify").push_min_score).toBe(65);
  });

  it("reports broken YAML without throwing out of the watcher", async () => {
    loadConfig("search");
    const { errors, fire, tick } = setup();
    fs.writeFileSync(path.join(tmp.configDir, "search.yaml"), "locations: [Berlin\n");
    fire("search.yaml");
    await tick(debounceMs);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("yaml");
  });

  it("stops after unsubscribe: closes the watchers and drops a debounce still waiting", async () => {
    const { events, watched, stop, fire, tick } = setup();
    edit("schedule.yaml", '"0 7 * * 1-5"', '"15 7 * * 1-5"');
    fire("schedule.yaml");
    stop();
    expect(watched.size).toBe(0);
    await tick(debounceMs * 2);
    expect(events).toHaveLength(0);
  });

  it("retries a directory it could not watch yet on each poll", async () => {
    const directories = fakeDirectories();
    directories.unavailable.add(tmp.configDir);
    const { tick } = setupFake({ debounceMs, pollMs: 100, fsWatch: true, watchDirectory: directories.watchDirectory });
    expect(directories.watched.has(tmp.configDir)).toBe(false);
    directories.unavailable.delete(tmp.configDir);
    await tick(100);
    expect(directories.watched.has(tmp.configDir)).toBe(true);
  });
});

/**
 * One real file system event, to prove the default wiring. How late the system delivers it is not ours to promise (on a busy Mac,
 * fseventsd has taken tens of seconds), so a second, plain `fs.watch` on the same directory is the clock: the deadline only starts once
 * the system has delivered the event at all, and a system that does not deliver in time skips the test instead of failing it.
 */
describe("watchConfig (fs.watch, real OS events)", () => {
  it("picks up a change", { timeout: REAL_EVENT_TEST_TIMEOUT_MS }, async (ctx) => {
    loadConfig("schedule");
    let delivered = false;
    const control = fs.watch(tmp.configDir, { persistent: false }, (_event, filename) => {
      if (filename === "schedule.yaml") delivered = true;
    });
    unsubscribers.push(() => control.close());
    const { events, errors } = start({ debounceMs: 50, pollMs: 0, fsWatch: true });
    // macOS can miss a change made in the first moments of a watch: repeat the change until the system reports one
    let cron = 1;
    const deadline = Date.now() + OS_DELIVERY_DEADLINE_MS;
    while (!delivered && Date.now() < deadline) {
      const file = path.join(tmp.configDir, "schedule.yaml");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"\d+ 7 \* \* 1-5"/, `"${cron++ % 60} 7 * * 1-5"`));
      await waitFor(() => delivered, 1000);
    }
    if (!delivered) {
      ctx.skip("the system did not deliver a file event in time");
      return;
    }
    expect(await waitFor(() => events.length > 0, AFTER_DELIVERY_DEADLINE_MS)).toBe(true);
    expect(events[0]?.name).toBe("schedule");
    expect(errors).toHaveLength(0);
  });
});
