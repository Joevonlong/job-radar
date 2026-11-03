// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commitConfigFile } from "@/lib/config/atomic";
import { ConfigError } from "@/lib/config";
import { atomicWrite } from "@/lib/config/write";
import {
  currentConfigWriteLock,
  isLockedConfigPath,
  lockLostError,
  setConfigWriteLockProviderForTests,
  withConfigWriteLock,
  type ConfigWriteLockProvider,
} from "@/lib/config/write-lock";

import { inProcessConfigWriteLock } from "./in-process-lock";
import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig({ user: "empty" }); });
afterEach(() => {
  vi.unstubAllEnvs();
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  tmp.cleanup();
});

const target = () => path.join(tmp.configDir, "sample.yaml");

/** A provider whose session answers `fence` as told and counts its releases. */
function session(fence: () => Promise<boolean>) {
  const state = { acquired: 0, released: 0 };
  const provider: ConfigWriteLockProvider = async () => {
    state.acquired += 1;
    return { acquired: true, lock: { fence, release: async () => { state.released += 1; } } };
  };
  setConfigWriteLockProviderForTests(provider);
  return state;
}

describe("setConfigWriteLockProviderForTests", () => {
  it("can only be used under vitest", () => {
    vi.stubEnv("VITEST", "");
    expect(() => setConfigWriteLockProviderForTests(inProcessConfigWriteLock)).toThrow(/only be replaced under vitest/);
    expect(() => setConfigWriteLockProviderForTests(null)).toThrow(/only be replaced under vitest/);
  });
});

describe("a write outside the lock", () => {
  it.each([
    ["the user config directory", () => target()],
    ["a subdirectory of it", () => path.join(tmp.configDir, ".backup", "editor", "ui.yaml.1")],
    ["the profile directory", () => path.join(tmp.profileDir, "me.yaml")],
  ])("atomicWrite refuses a file in %s and leaves no file behind", async (_name, file) => {
    await expect(atomicWrite(file(), "x: 1\n")).rejects.toThrow(/outside the config write lock/);
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(path.dirname(file())) ? fs.readdirSync(path.dirname(file())) : []).toEqual([]);
  });

  it("commitConfigFile refuses it as well", async () => {
    await expect(commitConfigFile(target(), "x: 1\n")).rejects.toThrow(/outside the config write lock/);
  });

  it("inside the lock the same write succeeds", async () => {
    await withConfigWriteLock(() => atomicWrite(target(), "x: 1\n"), target());
    expect(fs.readFileSync(target(), "utf8")).toBe("x: 1\n");
  });

  it("a file elsewhere needs no lock", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "not-config-"));
    try {
      await atomicWrite(path.join(elsewhere, "x.yaml"), "x: 1\n");
      expect(fs.readFileSync(path.join(elsewhere, "x.yaml"), "utf8")).toBe("x: 1\n");
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("isLockedConfigPath", () => {
  it("is true below the config and profile directories only", () => {
    expect(isLockedConfigPath(target())).toBe(true);
    expect(isLockedConfigPath(path.join(tmp.profileDir, "me.yaml"))).toBe(true);
    expect(isLockedConfigPath(path.join(tmp.configDir, "a", "b", "c.yaml"))).toBe(true);
    expect(isLockedConfigPath(tmp.configDir)).toBe(false);
    expect(isLockedConfigPath(path.join(tmp.configDir, "..", "elsewhere.yaml"))).toBe(false);
    expect(isLockedConfigPath(path.join(tmp.defaultsDir, "ui.yaml"))).toBe(false);
    // a sibling that merely starts with the same characters
    expect(isLockedConfigPath(`${tmp.configDir}-copy/ui.yaml`)).toBe(false);
  });
});

describe("isLockedConfigPath and symbolic links", () => {
  it("sees through a link to the config or profile directory, a link to a file in it, and a link to a file not there yet", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "not-config-")));
    try {
      fs.mkdirSync(tmp.configDir, { recursive: true });
      fs.mkdirSync(tmp.profileDir, { recursive: true });
      fs.symlinkSync(tmp.configDir, path.join(elsewhere, "dir-link"));
      fs.symlinkSync(tmp.profileDir, path.join(elsewhere, "profile-link"));
      fs.writeFileSync(target(), "x: 1\n");
      fs.symlinkSync(target(), path.join(elsewhere, "file-link.yaml"));
      fs.symlinkSync(path.join(tmp.configDir, "not-yet.yaml"), path.join(elsewhere, "dangling.yaml"));
      fs.symlinkSync(path.join(elsewhere, "dir-link"), path.join(elsewhere, "chain"));
      expect(isLockedConfigPath(path.join(elsewhere, "dir-link", "new.yaml"))).toBe(true);
      expect(isLockedConfigPath(path.join(elsewhere, "profile-link", "me.yaml"))).toBe(true);
      expect(isLockedConfigPath(path.join(elsewhere, "file-link.yaml"))).toBe(true);
      expect(isLockedConfigPath(path.join(elsewhere, "dangling.yaml"))).toBe(true);
      expect(isLockedConfigPath(path.join(elsewhere, "chain", "deep", "new.yaml"))).toBe(true);
      expect(isLockedConfigPath(path.join(elsewhere, "plain.yaml"))).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("a link whose target is outside stays unlocked, and a link loop does not hang", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "not-config-")));
    try {
      fs.mkdirSync(path.join(elsewhere, "real"));
      fs.symlinkSync(path.join(elsewhere, "real"), path.join(elsewhere, "ok-link"));
      fs.symlinkSync(path.join(elsewhere, "b"), path.join(elsewhere, "a"));
      fs.symlinkSync(path.join(elsewhere, "a"), path.join(elsewhere, "b"));
      expect(isLockedConfigPath(path.join(elsewhere, "ok-link", "x.yaml"))).toBe(false);
      expect(isLockedConfigPath(path.join(elsewhere, "a"))).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("withConfigWriteLock", () => {
  it("holds one session per call chain, shares it when nested, and releases it afterwards", async () => {
    const state = session(async () => true);
    expect(currentConfigWriteLock()).toBeNull();
    await withConfigWriteLock(async () => {
      expect(currentConfigWriteLock()).not.toBeNull();
      await withConfigWriteLock(async () => {}, target());
      expect(state).toEqual({ acquired: 1, released: 0 });
    }, target());
    expect(state).toEqual({ acquired: 1, released: 1 });
    expect(currentConfigWriteLock()).toBeNull();
  });

  it("releases the session when the work throws, and the next call takes a new one", async () => {
    const state = session(async () => true);
    await expect(withConfigWriteLock(async () => { throw new Error("work failed"); }, target())).rejects.toThrow("work failed");
    expect(state).toEqual({ acquired: 1, released: 1 });
    await withConfigWriteLock(async () => {}, target());
    expect(state.acquired).toBe(2);
  });

  it("a lock that is not granted is `busy`, naming the holder", async () => {
    setConfigWriteLockProviderForTests(async () => ({ acquired: false, holder: "job-radar config-write pid=7 host=h" }));
    const error = await withConfigWriteLock(async () => {}, target()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ kind: "busy", detail: "job-radar config-write pid=7 host=h", configName: "sample.yaml", filePath: target() });
    setConfigWriteLockProviderForTests(async () => ({ acquired: false, holder: null }));
    await expect(withConfigWriteLock(async () => {}, target())).rejects.toMatchObject({ kind: "busy", detail: "unknown holder" });
  });

  it("a database that cannot be reached is `db_unavailable`; other provider errors pass through", async () => {
    setConfigWriteLockProviderForTests(async () => { throw Object.assign(new Error("the database cannot be reached"), { name: "DbUnavailable" }); });
    await expect(withConfigWriteLock(async () => {}, target())).rejects.toMatchObject({ kind: "db_unavailable" });
    setConfigWriteLockProviderForTests(async () => { throw new Error("something else"); });
    await expect(withConfigWriteLock(async () => {}, target())).rejects.toThrow("something else");
  });

  it("never runs the work without the lock", async () => {
    setConfigWriteLockProviderForTests(async () => ({ acquired: false, holder: null }));
    const work = vi.fn(async () => {});
    await expect(withConfigWriteLock(work, target())).rejects.toBeInstanceOf(ConfigError);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("the ownership check at commit", () => {
  it("a lost session stops the commit with `busy` (lock_lost) and leaves the file as it was", async () => {
    fs.writeFileSync(target(), "old\n");
    session(async () => false);
    const error = await withConfigWriteLock(() => atomicWrite(target(), "new\n"), target()).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "busy", detail: "lock_lost" });
    expect(fs.readFileSync(target(), "utf8")).toBe("old\n");
    // no temp file left in the directory
    expect(fs.readdirSync(tmp.configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("lockLostError is the same error", () => {
    expect(lockLostError(target())).toMatchObject({ kind: "busy", detail: "lock_lost" });
  });

  it("the check runs after the base is compared, right before publishing", async () => {
    fs.writeFileSync(target(), "old\n");
    const order: string[] = [];
    session(async () => { order.push("fence"); return true; });
    await withConfigWriteLock(() => commitConfigFile(target(), "new\n", { checkFresh: () => void order.push("fresh") }), target());
    expect(order).toEqual(["fresh", "fence"]);
  });
});
