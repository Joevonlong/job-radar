// @vitest-environment node
/**
 * The process log level: `JOB_RADAR_LOG_LEVEL` > schedule.yaml `logging.level` > `info`, resolved lazily, followed after
 * a hot reload, bounded in what it reads, and never throwing.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { loadConfig, refreshConfigCache, resetConfigCache, watchConfig } from "@/lib/config";
import { DEFAULT_CONFIG_POLL_MS } from "@/lib/config/paths";
import { createProcessLogger, resetLogLevelResolver, resolveLogLevel } from "@/lib/logging/process-logger";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const INTERVAL_MS = 1000;

let tmp: TempConfig;
let savedLevel: string | undefined;
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  tmp = makeTempConfig();
  savedLevel = process.env.JOB_RADAR_LOG_LEVEL;
  delete process.env.JOB_RADAR_LOG_LEVEL;
  process.env.JOB_RADAR_CONFIG_POLL_MS = String(INTERVAL_MS);
  vi.useFakeTimers({ toFake: ["Date"] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // the loader reports a bad file on console.error; that is its own diagnostic, not the resolver's
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetLogLevelResolver();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedLevel === undefined) delete process.env.JOB_RADAR_LOG_LEVEL;
  else process.env.JOB_RADAR_LOG_LEVEL = savedLevel;
  resetLogLevelResolver();
  tmp.cleanup();
});

const scheduleFile = () => path.join(tmp.configDir, "schedule.yaml");
const original = () => fs.readFileSync(path.join(tmp.defaultsDir, "schedule.yaml"), "utf8");

/** The user schedule.yaml with `logging.level: <level>` added (or a raw logging block). */
function writeLevel(level: string): void {
  fs.writeFileSync(scheduleFile(), `${original()}\nlogging:\n  level: ${level}\n`);
}

/** How many times the code touches the file system (reads and existence checks) while `fn` runs. */
function countFsCalls(fn: () => void): number {
  const read = vi.spyOn(fs, "readFileSync");
  const exists = vi.spyOn(fs, "existsSync");
  const stat = vi.spyOn(fs, "statSync");
  try {
    fn();
    return read.mock.calls.length + exists.mock.calls.length + stat.mock.calls.length;
  } finally {
    read.mockRestore();
    exists.mockRestore();
    stat.mockRestore();
  }
}

/** How many times schedule.yaml is read while `fn` runs. */
function countScheduleReads(fn: () => void): number {
  const read = vi.spyOn(fs, "readFileSync");
  try {
    fn();
    return read.mock.calls.filter(([file]) => String(file).endsWith("schedule.yaml")).length;
  } finally {
    read.mockRestore();
  }
}

const resolverWarnings = () => warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[logging]"));

describe("resolveLogLevel: precedence", () => {
  it("is info when neither the variable nor the config sets it", () => {
    expect(resolveLogLevel()).toBe("info");
    expect(resolverWarnings()).toEqual([]);
  });

  it("takes logging.level from schedule.yaml", () => {
    writeLevel("warn");
    expect(resolveLogLevel()).toBe("warn");
  });

  it("lets JOB_RADAR_LOG_LEVEL win over the config (case and spaces do not matter)", () => {
    writeLevel("warn");
    process.env.JOB_RADAR_LOG_LEVEL = " DEBUG ";
    expect(resolveLogLevel()).toBe("debug");
  });

  it.each(["", "   "])("treats %j as unset, without a warning", (value) => {
    writeLevel("error");
    process.env.JOB_RADAR_LOG_LEVEL = value;
    expect(resolveLogLevel()).toBe("error");
    expect(resolverWarnings()).toEqual([]);
  });

  it("treats an invalid value as unset (the config applies) and warns once without echoing it", () => {
    writeLevel("warn");
    process.env.JOB_RADAR_LOG_LEVEL = "verbose-secretish";
    expect(resolveLogLevel()).toBe("warn");
    vi.advanceTimersByTime(INTERVAL_MS * 3);
    expect(resolveLogLevel()).toBe("warn");
    const warnings = resolverWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("JOB_RADAR_LOG_LEVEL");
    expect(warnings[0]).not.toContain("verbose-secretish");
  });

  it("falls back to info for an invalid variable when the config does not set a level", () => {
    process.env.JOB_RADAR_LOG_LEVEL = "loud";
    expect(resolveLogLevel()).toBe("info");
  });
});

describe("resolveLogLevel: config cases (on-demand refresh, no watcher)", () => {
  it("never loaded: info, one warning, retried once per interval, adopted once fixed", () => {
    writeLevel("loud");
    expect(resolveLogLevel()).toBe("info");
    expect(resolverWarnings()).toHaveLength(1);
    expect(resolverWarnings()[0]).toContain("schedule");
    // still broken after the interval: retried, no second warning
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(countScheduleReads(() => resolveLogLevel())).toBe(1);
    expect(resolveLogLevel()).toBe("info");
    expect(resolverWarnings()).toHaveLength(1);
    // fixed: taken within one interval
    writeLevel("debug");
    expect(resolveLogLevel()).toBe("info");
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(resolveLogLevel()).toBe("debug");
  });

  it("warns with the first line of the config error only (the loader already reported the whole message)", () => {
    writeLevel("loud");
    expect(resolveLogLevel()).toBe("info");
    const [line] = resolverWarnings();
    expect(line).toContain("could not read logging.level from schedule.yaml");
    expect(line).toContain("failed validation");
    expect(line).not.toContain("\n");
    // the field-level lines of the message stay out of the resolver's warning
    expect(line).not.toContain("logging.level:");
  });

  it("follows valid -> broken -> fixed without a restart, as seen through a logger", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createProcessLogger();
    const written = () => out.mock.calls.length + warn.mock.calls.filter(([line]) => String(line).includes("WARN")).length;
    /** Writes one debug and one warn record; returns [debug written, warn written]. */
    const probe = (): [boolean, boolean] => {
      const before = written();
      logger.debug("probe debug");
      const afterDebug = written();
      logger.warn("probe warn");
      return [afterDebug > before, written() > afterDebug];
    };

    writeLevel("warn");
    expect(resolveLogLevel()).toBe("warn");
    expect(probe()).toEqual([false, true]);

    // broken: the loader keeps the last valid file after the poll, the level stays
    writeLevel("loud");
    refreshConfigCache();
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(resolveLogLevel()).toBe("warn");
    expect(probe()).toEqual([false, true]);

    // fixed to another level: taken within one interval
    writeLevel("debug");
    refreshConfigCache();
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(resolveLogLevel()).toBe("debug");
    expect(probe()).toEqual([true, true]);

    // and a later change is still followed
    writeLevel("error");
    refreshConfigCache();
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(probe()).toEqual([false, false]);
    expect(resolverWarnings()).toEqual([]);
  });

  it("broken later: keeps the last valid level (as the loader keeps the last valid file), without a resolver warning", () => {
    writeLevel("warn");
    expect(resolveLogLevel()).toBe("warn");
    writeLevel("loud");
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(resolveLogLevel()).toBe("warn");
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(resolveLogLevel()).toBe("warn");
    expect(resolverWarnings()).toEqual([]);
  });

  it("fixed / changed: the new level within one interval", () => {
    writeLevel("warn");
    expect(resolveLogLevel()).toBe("warn");
    writeLevel("debug");
    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(resolveLogLevel()).toBe("warn");
    vi.advanceTimersByTime(1);
    expect(resolveLogLevel()).toBe("debug");
  });

  it("follows refreshConfigCache (runner and ai-worker at each cycle / request)", () => {
    writeLevel("warn");
    expect(resolveLogLevel()).toBe("warn");
    writeLevel("error");
    refreshConfigCache();
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(resolveLogLevel()).toBe("error");
  });
});

describe("resolveLogLevel: config cases (watcher)", () => {
  const unsubscribers: Array<() => void> = [];
  afterEach(() => {
    while (unsubscribers.length > 0) unsubscribers.pop()?.();
  });

  /** A polling watcher on fake timers (no OS events): `tick` moves the clock and runs its timers. */
  function startWatcher(): (ms: number) => Promise<void> {
    vi.useFakeTimers();
    unsubscribers.push(watchConfig("all", () => undefined, { fsWatch: false, debounceMs: 10, pollMs: 100, onError: () => undefined }));
    return async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
  }

  it("never loaded, then fixed", async () => {
    writeLevel("loud");
    const tick = startWatcher();
    expect(resolveLogLevel()).toBe("info");
    expect(resolverWarnings()).toHaveLength(1);
    writeLevel("debug");
    await tick(INTERVAL_MS);
    expect(resolveLogLevel()).toBe("debug");
    expect(resolverWarnings()).toHaveLength(1);
  });

  it("valid, broken, fixed", async () => {
    writeLevel("warn");
    const tick = startWatcher();
    expect(resolveLogLevel()).toBe("warn");
    writeLevel("loud");
    await tick(INTERVAL_MS * 2);
    expect(resolveLogLevel()).toBe("warn");
    writeLevel("error");
    await tick(INTERVAL_MS);
    expect(resolveLogLevel()).toBe("error");
    expect(resolverWarnings()).toEqual([]);
  });
});

describe("resolveLogLevel: cost", () => {
  it("touches no file in the steady state", () => {
    writeLevel("warn");
    resolveLogLevel();
    expect(countFsCalls(() => {
      for (let i = 0; i < 1000; i += 1) resolveLogLevel();
    })).toBe(0);
  });

  it("with the variable set, never asks the config at all", () => {
    process.env.JOB_RADAR_LOG_LEVEL = "debug";
    expect(countFsCalls(() => {
      for (let i = 0; i < 100; i += 1) {
        resolveLogLevel();
        vi.advanceTimersByTime(INTERVAL_MS);
      }
    })).toBe(0);
  });

  it("retries a config that never loaded at most once per interval", () => {
    writeLevel("loud");
    const reads = countScheduleReads(() => {
      // 10 intervals, 100 records in each
      for (let interval = 0; interval < 10; interval += 1) {
        for (let i = 0; i < 100; i += 1) resolveLogLevel();
        vi.advanceTimersByTime(INTERVAL_MS);
      }
    });
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(10);
  });

  it("uses the default interval as the floor when JOB_RADAR_CONFIG_POLL_MS is 0", () => {
    process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
    writeLevel("loud");
    resolveLogLevel();
    expect(countScheduleReads(() => {
      for (let i = 0; i < 1000; i += 1) resolveLogLevel();
      vi.advanceTimersByTime(DEFAULT_CONFIG_POLL_MS - 1);
      for (let i = 0; i < 1000; i += 1) resolveLogLevel();
    })).toBe(0);
    vi.advanceTimersByTime(1);
    expect(countScheduleReads(() => {
      for (let i = 0; i < 1000; i += 1) resolveLogLevel();
    })).toBe(1);
  });

  it("does not loop when a warning's output asks for the level again", () => {
    writeLevel("loud");
    let nested = 0;
    warn.mockImplementation(() => {
      nested += 1;
      resolveLogLevel();
    });
    expect(resolveLogLevel()).toBe("info");
    expect(nested).toBe(1);
  });
});

describe("createLogger with a level function", () => {
  it("uses info and does not throw when the function throws", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      sink: (r) => records.push(r),
      minLevel: () => {
        throw new Error("boom");
      },
    });
    expect(() => {
      logger.debug("hidden");
      logger.info("shown");
      logger.child({ a: 1 }).debug("hidden too");
    }).not.toThrow();
    expect(records.map((r) => r.message)).toEqual(["shown"]);
  });
});

describe("createProcessLogger", () => {
  it("writes debug records to the console output when the config says debug, and follows a reload (parent and child)", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeLevel("debug");
    const logger = createProcessLogger();
    const child = logger.child({ component: "test" });
    logger.debug("parent debug");
    child.debug("child debug");
    expect(out.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining("DEBUG parent debug"), expect.stringContaining("DEBUG child debug")]);

    writeLevel("warn");
    refreshConfigCache();
    vi.advanceTimersByTime(INTERVAL_MS);
    out.mockClear();
    logger.info("parent info");
    child.info("child info");
    logger.debug("parent debug");
    expect(out).not.toHaveBeenCalled();
    logger.warn("parent warn");
    child.warn("child warn");
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining("WARN parent warn"), expect.stringContaining("WARN child warn")]);
  });

  it("reads no config when it is created, only when a record is written", () => {
    writeLevel("debug");
    resetConfigCache();
    const records: LogRecord[] = [];
    let logger: ReturnType<typeof createProcessLogger> | undefined;
    expect(countScheduleReads(() => {
      logger = createProcessLogger({ sink: (r) => records.push(r) });
    })).toBe(0);
    expect(countScheduleReads(() => logger?.debug("now"))).toBe(1);
    expect(records.map((r) => r.message)).toEqual(["now"]);
    expect(loadConfig("schedule").logging.level).toBe("debug");
  });
});
