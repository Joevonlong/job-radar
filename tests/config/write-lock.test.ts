// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { resetConfigCache } from "@/lib/config";
import { atomicWrite } from "@/lib/config/write";
import { withDirectoryWriteLock, WRITE_LOCK_FILE } from "@/lib/config/write-lock";

import { makeTempConfig, sleep, waitFor, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });
const repo = path.resolve(import.meta.dirname, "../..");
const lockPath = () => path.join(tmp.configDir, WRITE_LOCK_FILE);

function lockPolicy() {
  const file = path.join(tmp.configDir, "schedule.yaml");
  const value = parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  value.deploy = { prune_build_cache: false, build_cache_keep_gb: 0, prune_dangling_images: false, config_write_lock_stale_seconds: 2, config_write_lock_wait_seconds: 0.05, config_write_lock_retry_ms: 5 };
  fs.writeFileSync(file, stringify(value)); resetConfigCache();
}

function putOwner(kind: "lease" | "guard", pid: number, host: string, old: boolean): string {
  const token = "0".repeat(32);
  const file = kind === "lease" ? lockPath() : path.join(`${lockPath()}.guard`, token);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token, pid, host, started: new Date().toISOString() }));
  if (old) fs.utimesSync(file, new Date(0), new Date(0));
  return file;
}

function startWriter(file: string, record: string, text: string, hold = "", extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", path.join(repo, "node_modules/tsx/dist/loader.mjs"), path.join(repo, "tests/fixtures/ops/config-write-child.ts"), file, text, record, hold], {
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"), ...extra }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const done = new Promise<void>((resolve, reject) => child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr))));
  return { child, done };
}

describe("cross-process config write lock", () => {
  it("serializes two actual child processes writing the same file", async () => {
    const record = path.join(tmp.root, "record");
    const gate = path.join(tmp.root, "continue");
    const file = path.join(tmp.configDir, "sample.yaml");
    const first = startWriter(file, record, "first", gate);
    let second: ReturnType<typeof startWriter> | undefined;
    try {
      expect(await waitFor(() => fs.existsSync(record), 10000)).toBe(true);
      second = startWriter(file, record, "second");
      await sleep(200);
      expect(fs.readFileSync(record, "utf8")).toBe("first:enter\n");
      fs.writeFileSync(gate, "");
      await Promise.all([first.done, second.done]);
      expect(fs.readFileSync(record, "utf8")).toBe("first:enter\nfirst:leave\nsecond:enter\nsecond:leave\n");
      expect(fs.readFileSync(file, "utf8")).toBe("second");
      expect(fs.existsSync(lockPath())).toBe(false);
    } finally {
      first.child.kill(); second?.child.kill();
      await Promise.allSettled([first.done, second?.done]);
    }
  });

  it("a delayed stale reclaimer cannot unlink the lock acquired by another process", async () => {
    fs.writeFileSync(lockPath(), "stale owner"); fs.utimesSync(lockPath(), new Date(0), new Date(0));
    const file = path.join(tmp.configDir, "sample.yaml");
    const record = path.join(tmp.root, "record");
    const ready = path.join(tmp.root, "before-unlink");
    const resume = path.join(tmp.root, "resume-unlink");
    const gate = path.join(tmp.root, "commit-first");
    const first = startWriter(file, record, "first", gate, { CONFIG_WRITE_PAUSE_UNLINK: ready, CONFIG_WRITE_RESUME_UNLINK: resume });
    let second: ReturnType<typeof startWriter> | undefined;
    try {
      expect(await waitFor(() => fs.existsSync(ready), 10000)).toBe(true);
      const secondStarted = path.join(tmp.root, "second-started");
      second = startWriter(file, record, "second", "", { CONFIG_WRITE_STARTED: secondStarted });
      expect(await waitFor(() => fs.existsSync(secondStarted), 10000)).toBe(true);
      await sleep(200);
      expect(fs.existsSync(record)).toBe(false);
      fs.writeFileSync(resume, "");
      expect(await waitFor(() => fs.existsSync(record), 10000)).toBe(true);
      expect(fs.readFileSync(record, "utf8")).toBe("first:enter\n");
      fs.writeFileSync(gate, "");
      await Promise.all([first.done, second.done]);
      expect(fs.readFileSync(record, "utf8")).toBe("first:enter\nfirst:leave\nsecond:enter\nsecond:leave\n");
      expect(fs.readFileSync(file, "utf8")).toBe("second");
    } finally {
      first.child.kill(); second?.child.kill();
      await Promise.allSettled([first.done, second?.done]);
    }
  });

  it("fences a paused foreign holder after time-based takeover and preserves the successor's lease on release", async () => {
    lockPolicy();
    const guard = `${lockPath()}.guard`;
    putOwner("guard", process.pid, "crashed-container.invalid", true);
    const file = path.join(tmp.configDir, "sample.yaml");
    const record = path.join(tmp.root, "record");
    const gate = path.join(tmp.root, "continue");
    vi.spyOn(os, "hostname").mockReturnValue("paused-container.invalid");
    let successor: ReturnType<typeof startWriter> | undefined;
    try {
      await expect(atomicWrite(file, "first", async () => {
        // Advance only the contender's clock past the configured threshold, without sleeping or changing the lease.
        successor = startWriter(file, record, "successor", gate, { CONFIG_WRITE_CLOCK_OFFSET_MS: "3000" });
        expect(await waitFor(() => fs.existsSync(record), 10000)).toBe(true);
      })).rejects.toMatchObject({ kind: "busy" });
      expect(JSON.parse(fs.readFileSync(lockPath(), "utf8"))).toMatchObject({ pid: successor?.child.pid });
      expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(gate, "");
      await successor?.done;
      expect(fs.readFileSync(file, "utf8")).toBe("successor");
      expect(fs.existsSync(lockPath())).toBe(false);
      expect(fs.existsSync(guard)).toBe(false);
    } finally {
      successor?.child.kill();
      await Promise.allSettled([successor?.done]);
    }
  });

  it.each(["lease", "guard"] as const)("never takes over a live same-host %s even past the stale threshold", async (kind) => {
    lockPolicy();
    const owner = putOwner(kind, process.ppid, os.hostname(), true);
    const before = fs.readFileSync(owner, "utf8");
    await expect(atomicWrite(path.join(tmp.configDir, "sample.yaml"), "new")).rejects.toMatchObject({ kind: "busy" });
    expect(fs.readFileSync(owner, "utf8")).toBe(before);
  });

  it.each(["lease", "guard"] as const)("takes over a dead same-host %s without waiting for its age", async (kind) => {
    lockPolicy();
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(exited.status).toBe(0);
    putOwner(kind, Number(exited.stdout), os.hostname(), false);
    await atomicWrite(path.join(tmp.configDir, "sample.yaml"), "new");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it.each(["lease", "guard"] as const)("takes over a reused same-host PID with a different generation in its %s immediately", async (kind) => {
    lockPolicy();
    const owner = putOwner(kind, process.pid, os.hostname(), false);
    const previous = JSON.parse(fs.readFileSync(owner, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(owner, JSON.stringify({ ...previous, generation: "f".repeat(32), processStartedAt: Date.now() - 1000 }));
    const file = path.join(tmp.configDir, "sample.yaml");
    await atomicWrite(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.existsSync(owner)).toBe(false);
  });

  it("keeps a token held by this process generation live in another async context", async () => {
    lockPolicy();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const guards: Record<string, unknown>[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === `${lockPath()}.guard`) {
        const candidate = String(from);
        guards.push(JSON.parse(fs.readFileSync(path.join(candidate, fs.readdirSync(candidate)[0]), "utf8")) as Record<string, unknown>);
      }
      return rename(from, to);
    });
    const first = withDirectoryWriteLock(tmp.configDir, async () => {
      ready.resolve();
      await release.promise;
    });
    try {
      await ready.promise;
      const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as Record<string, unknown>;
      expect(owner).toMatchObject({ pid: process.pid, host: os.hostname(), generation: expect.stringMatching(/^[0-9a-f]{32}$/), processStartedAt: expect.any(Number) });
      expect(Math.abs(Number(owner.processStartedAt) - (Date.now() - process.uptime() * 1000))).toBeLessThan(1000);
      expect(guards[0]).toMatchObject({ generation: owner.generation, processStartedAt: owner.processStartedAt, token: expect.stringMatching(/^[0-9a-f]{32}$/) });
      fs.utimesSync(lockPath(), new Date(0), new Date(0));
      await expect(atomicWrite(path.join(tmp.configDir, "sample.yaml"), "contender")).rejects.toMatchObject({ kind: "busy" });
      expect(JSON.parse(fs.readFileSync(lockPath(), "utf8"))).toEqual(owner);
    } finally { release.resolve(); await first; }
  });

  it.each(["lease", "guard"] as const)("recovers its own abandoned %s after release fails", async (kind) => {
    lockPolicy();
    const unlink = fs.unlinkSync;
    let failed = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (!failed && (kind === "lease" ? String(file) === lockPath() : String(file).startsWith(`${lockPath()}.guard/`))) {
        failed = true;
        throw Object.assign(new Error("release failed"), { code: "EACCES" });
      }
      return unlink(file);
    });
    const file = path.join(tmp.configDir, "sample.yaml");
    await expect(atomicWrite(file, "first")).rejects.toThrow("release failed");
    expect(failed).toBe(true);
    await atomicWrite(file, "recovered");
    expect(fs.readFileSync(file, "utf8")).toBe("recovered");
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(`${lockPath()}.guard`)).toBe(false);
  });

  it.each(["lease", "guard"] as const)("only takes over a foreign-host %s after the threshold", async (kind) => {
    lockPolicy();
    const owner = putOwner(kind, process.pid, "container.invalid", false);
    await expect(atomicWrite(path.join(tmp.configDir, "sample.yaml"), "new")).rejects.toMatchObject({ kind: "busy" });
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3000);
    await atomicWrite(path.join(tmp.configDir, "sample.yaml"), "new");
    expect(fs.existsSync(owner)).toBe(false);
    expect(fs.readFileSync(path.join(tmp.configDir, "sample.yaml"), "utf8")).toBe("new");
  });

  it("returns busy after the configured wait and leaves the active owner's lock and file untouched", async () => {
    const schedule = path.join(tmp.configDir, "schedule.yaml");
    const value = parse(fs.readFileSync(schedule, "utf8")) as Record<string, unknown>;
    value.deploy = { prune_build_cache: false, build_cache_keep_gb: 0, prune_dangling_images: false, config_write_lock_wait_seconds: 0.05, config_write_lock_retry_ms: 5 };
    fs.writeFileSync(schedule, stringify(value)); resetConfigCache();
    fs.writeFileSync(lockPath(), "active");
    await expect(atomicWrite(path.join(tmp.configDir, "sample.yaml"), "new")).rejects.toMatchObject({ kind: "busy" });
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("active");
    expect(fs.existsSync(path.join(tmp.configDir, "sample.yaml"))).toBe(false);
  });
});
