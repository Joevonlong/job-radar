// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configFreezeCheck } from "@/lib/ops/doctor/checks/config";
import { createRealProbes } from "@/lib/ops/doctor/probes";
import { readReleasesLock } from "@/lib/ops/releases-lock";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { makeContext, only } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

describe("config.freeze", () => {
  it.each([false, true].flatMap((freeze) => [false, true].map((lock) => ({ freeze, lock }))))("marker=$freeze, active deploy=$lock", async ({ freeze, lock }) => {
    if (freeze) fs.writeFileSync(path.join(tmp.configDir, ".upgrade-freeze"), "private token must never appear");
    if (lock) {
      const dir = path.join(tmp.root, "data/releases/ai-worker/.lock");
      fs.mkdirSync(path.join(dir, "inflight"), { recursive: true });
      fs.writeFileSync(path.join(dir, "inflight", String(process.pid)), `script=deploy.sh\npid=${process.pid}\nstarted=1\n`);
    }
    const probes = createRealProbes({ commandTimeoutMs: 100, probeTimeoutMs: 100, now: () => new Date(), migrationsDir: path.join(tmp.root, "migrations") });
    const ctx = makeContext({ locale: "en", probes: { configFrozen: probes.configFrozen, releasesLock: () => readReleasesLock(tmp.root) } });
    const r = await only(configFreezeCheck, ctx);
    expect(r.status).toBe(freeze && !lock ? "warn" : "ok");
    expect(JSON.stringify(r)).not.toContain("private token");
    if (freeze && !lock) expect(r.hint).toContain("pnpm ops:unfreeze");
  });

  it.each(["config", "profile"].flatMap((directory) => ["lease", "guard"].flatMap((kind) => [false, true].map((old) => ({ directory, kind, old })))))
  ("reports a stale write-lock owner: $directory $kind old=$old", async ({ directory, kind, old }) => {
    const dir = directory === "config" ? tmp.configDir : tmp.profileDir;
    const lock = path.join(dir, kind === "lease" ? ".write.lock" : ".write.lock.guard");
    const owner = kind === "lease" ? lock : path.join(lock, "0".repeat(32));
    fs.mkdirSync(path.dirname(owner), { recursive: true });
    fs.writeFileSync(owner, "private owner token must never appear");
    const now = new Date();
    const thresholdSeconds = 2;
    const stamp = new Date(now.getTime() - (old ? thresholdSeconds + 1 : 1) * 1000);
    fs.utimesSync(owner, stamp, stamp);
    const probes = createRealProbes({ commandTimeoutMs: 100, probeTimeoutMs: 100, now: () => now, migrationsDir: path.join(tmp.root, "migrations") });
    const ctx = makeContext({ locale: "en", probes: { configFrozen: probes.configFrozen, staleConfigWriteLocks: probes.staleConfigWriteLocks } });
    ctx.config.schedule.deploy.config_write_lock_stale_seconds = thresholdSeconds;
    const r = await only(configFreezeCheck, ctx);
    expect(r.status).toBe(old ? "warn" : "ok");
    if (old) {
      expect(r.detail).toContain(lock);
      expect(r.hint).toContain("automatically on the next write");
      expect(r.hint).toContain("remove");
    }
    expect(JSON.stringify(r)).not.toContain("private owner");
    expect(JSON.stringify(r)).not.toContain("0".repeat(32));
  });
});
