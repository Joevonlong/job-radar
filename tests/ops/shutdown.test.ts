// @vitest-environment node
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exitProcess, installShutdown } from "@/lib/ops/shutdown";
import { withTimeout } from "@/lib/ops/timeout";

function setup(graceMs = 5000) {
  const target = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  const abort = new AbortController();
  const shutdown = installShutdown({ log: (m) => logs.push(m), abort, graceMs: () => graceMs, exit: (c) => exits.push(c), target: target as unknown as NodeJS.Process });
  return { target, logs, exits, abort, shutdown };
}

describe("installShutdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a signal aborts and logs it; a normal finish before the grace period never forces an exit", () => {
    const { target, logs, exits, abort, shutdown } = setup();
    target.emit("SIGTERM");
    expect(abort.signal.aborted).toBe(true);
    expect(logs).toEqual(["received SIGTERM, shutting down"]);
    shutdown.done();
    vi.advanceTimersByTime(60_000);
    expect(exits).toEqual([]);
  });

  it("forces exit(1) with an error line when the shutdown does not finish within the grace period", () => {
    const { target, logs, exits } = setup(5000);
    target.emit("SIGTERM");
    vi.advanceTimersByTime(4999);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(exits).toEqual([1]);
    expect(logs.at(-1)).toBe("ERROR shutdown did not finish within 5s: forcing exit");
  });

  it("a second signal forces exit at once", () => {
    const { target, logs, exits } = setup();
    target.emit("SIGTERM");
    target.emit("SIGINT");
    expect(exits).toEqual([1]);
    expect(logs.at(-1)).toContain("again while shutting down: forcing exit");
  });

  it("an unhandled rejection / uncaught exception is logged as an error with the reason and starts the shutdown with exit code 1", () => {
    const { target, logs, abort, shutdown } = setup();
    target.emit("unhandledRejection", new Error("boom"));
    expect(abort.signal.aborted).toBe(true);
    expect(logs[0]).toBe("ERROR unhandled rejection: Error: boom, shutting down");
    expect(shutdown.exitCode()).toBe(1);
    const second = setup();
    second.target.emit("uncaughtException", new TypeError("bad"));
    expect(second.logs[0]).toBe("ERROR uncaught exception: TypeError: bad, shutting down");
  });
});

const fixture = path.resolve(__dirname, "../fixtures/hung-shutdown.ts");

/** Start the fixture in its own process and resolve once it printed "ready". */
async function startChild(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], { env: { ...process.env, ...env }, cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("ready")) resolve();
    });
    child.on("error", reject);
    exited.then(() => reject(new Error(`child exited early: ${out}`)));
  });
  return { child, exited, output: () => out };
}

describe("a real process with a shutdown that never finishes", () => {
  it("exits by itself after the grace period", async () => {
    const { child, exited, output } = await startChild({ GRACE_MS: "700" });
    const started = Date.now();
    child.kill("SIGTERM");
    const result = await exited;
    expect(result).toEqual({ code: 1, signal: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(output()).toContain("received SIGTERM, shutting down");
    expect(output()).toContain("ERROR shutdown did not finish within 1s: forcing exit");
  }, 30_000);

  it("a second SIGTERM exits it immediately", async () => {
    const { child, exited } = await startChild({ GRACE_MS: "60000" });
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 1, signal: null });
  }, 30_000);

  it("an unhandled rejection is an error that ends the process", async () => {
    const { exited, output } = await startChild({ GRACE_MS: "500", THROW: "1" });
    expect(await exited).toEqual({ code: 1, signal: null });
    expect(output()).toContain("ERROR unhandled rejection: Error: boom, shutting down");
  }, 30_000);
});

describe("exitProcess", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses process.exit normally and SIGKILLs itself once work was abandoned (a stuck fs call would make process.exit hang)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    exitProcess(3);
    expect(exit).toHaveBeenCalledWith(3);
    expect(kill).not.toHaveBeenCalled();
    await expect(withTimeout(new Promise<never>(() => {}), 10, "stuck read")).rejects.toThrow("stuck read");
    exitProcess(0);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
  });
});
