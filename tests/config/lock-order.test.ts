// @vitest-environment node
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, writeConfig } from "@/lib/config";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

const file = () => path.join(tmp.configDir, "ui.yaml");

describe("lock order: the file lock first, then the config write lock", () => {
  it("the normal order works, with the work running inside both", async () => {
    const seen: string[] = [];
    await withFileLock(file(), () => withConfigWriteLock(async () => { seen.push("work"); }, file()));
    expect(seen).toEqual(["work"]);
  });

  it("taking a file lock while the call chain holds the config write lock throws, and does not run the work", async () => {
    let ran = false;
    await expect(withConfigWriteLock(() => withFileLock(file(), async () => { ran = true; }), file())).rejects.toThrow(/file lock taken inside the config write lock: ui\.yaml/);
    expect(ran).toBe(false);
  });

  it("applies to any writer that takes the file lock, such as writeConfig", async () => {
    const value = structuredClone(loadConfig("ui"));
    await expect(withConfigWriteLock(() => writeConfig("ui", value), file())).rejects.toThrow(/file lock taken inside the config write lock/);
  });

  it("the refusal does not poison the file lock: the same file can be locked right afterwards", async () => {
    await withConfigWriteLock(() => withFileLock(file(), async () => {}), file()).catch(() => undefined);
    await expect(withFileLock(file(), async () => "ok")).resolves.toBe("ok");
  });

  it("a nested config write lock in the same chain is shared, not a second acquisition", async () => {
    let inner = false;
    await withFileLock(file(), () => withConfigWriteLock(() => withConfigWriteLock(async () => { inner = true; }, file()), file()));
    expect(inner).toBe(true);
  });
});
