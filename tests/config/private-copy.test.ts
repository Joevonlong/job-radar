// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyPrivateIfMissing } from "@/lib/config/private-file";

let dir = "";
let umask = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-private-copy-"));
  // the most permissive umask: the mode must come from the code, not from the process
  umask = process.umask(0);
});
afterEach(() => {
  process.umask(umask);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("copyPrivateIfMissing (seeded config and profile files)", () => {
  it("creates the copy owner-only from the first byte, whatever the source's mode", async () => {
    const source = path.join(dir, "me.yaml");
    fs.writeFileSync(source, "name: x\n", { mode: 0o644 });
    fs.chmodSync(source, 0o644);
    const target = path.join(dir, "copy.yaml");
    const seen: number[] = [];
    // watch the file while it is being created: it must never be readable by others
    const watcher = fs.watch(dir, () => {
      try {
        seen.push(fs.statSync(target).mode & 0o777);
      } catch {
        // not there yet
      }
    });
    try {
      expect(await copyPrivateIfMissing(source, target)).toBe(true);
    } finally {
      watcher.close();
    }
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(seen.every((mode) => mode === 0o600)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("name: x\n");
  });

  it("never overwrites an existing file", async () => {
    const source = path.join(dir, "a.yaml");
    const target = path.join(dir, "b.yaml");
    fs.writeFileSync(source, "new\n");
    fs.writeFileSync(target, "mine\n", { mode: 0o600 });
    expect(await copyPrivateIfMissing(source, target)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("mine\n");
  });

  it("a write that fails after the file was created leaves no file behind (the next run seeds it again)", async () => {
    const source = path.join(dir, "me.yaml");
    fs.writeFileSync(source, "name: x\n");
    const target = path.join(dir, "copy.yaml");
    const realOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    let targetFd = -1;
    const open = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...args);
      if (args[0] === target) targetFd = fd;
      return fd;
    });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === targetFd) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      return realWrite(...args);
    });
    try {
      await expect(copyPrivateIfMissing(source, target)).rejects.toThrow(/no space/);
    } finally { open.mockRestore(); write.mockRestore(); }
    expect(fs.existsSync(target)).toBe(false);
    expect(await copyPrivateIfMissing(source, target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("name: x\n");
  });
});
