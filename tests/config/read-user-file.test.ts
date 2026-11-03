import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mutateConfig, reloadConfig } from "@/lib/config";
import { readUserFile, readUserText } from "@/lib/config/read-user-file";

import { makeTempConfig } from "./helpers";

const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

describe("reading a file another process may have just replaced", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-user-file-"));
    file = path.join(dir, "ui.yaml");
    fs.writeFileSync(file, "a: 1\n");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The bind mount's gap: open answers ENOENT `times` times while the entry stays there. */
  function openFailsFor(times: number) {
    const real = fs.readFileSync;
    let left = times;
    return vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof real>) => {
      if (left > 0) {
        left -= 1;
        throw enoent();
      }
      return real(...args);
    }) as typeof real);
  }

  it("reads a file", () => {
    expect(readUserText(file)).toBe("a: 1\n");
  });

  it("says ENOENT at once for a file that is not there", () => {
    const list = vi.spyOn(fs, "readdirSync");
    expect(() => readUserFile(path.join(dir, "absent.yaml"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(list).not.toHaveBeenCalled();
  });

  it("says ENOENT for a dangling link", () => {
    const link = path.join(dir, "link.yaml");
    fs.symlinkSync(path.join(dir, "gone.yaml"), link);
    expect(() => readUserFile(link)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("does not take the gap for a missing file: it reads the file once the entry is back", () => {
    const list = vi.spyOn(fs, "readdirSync");
    openFailsFor(3);
    const gaps: number[] = [];
    expect(readUserFile(file, (waited) => gaps.push(waited)).toString()).toBe("a: 1\n");
    expect(gaps).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(dir);
  });

  it("reports no gap when the first read works", () => {
    const gaps: number[] = [];
    readUserFile(file, (waited) => gaps.push(waited));
    expect(gaps).toEqual([]);
  });

  it("fails with something other than ENOENT when the file stays unreadable", () => {
    openFailsFor(Number.POSITIVE_INFINITY);
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    let calls = 0;
    now.mockImplementation(() => start + (calls++ > 2 ? 60_000 : 0));
    const error = (() => {
      try {
        readUserFile(file);
        return null;
      } catch (caught) {
        return caught as NodeJS.ErrnoException;
      }
    })();
    expect(error?.code).toBe("EAGAIN");
    expect(error?.message).toContain("ui.yaml");
  });

  it("passes other read errors on", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(() => readUserFile(file)).toThrow(expect.objectContaining({ code: "EACCES" }));
  });

  it("keeps a writer on the user's text during the gap: it never starts over from the defaults", async () => {
    const temp = makeTempConfig();
    try {
      const target = path.join(temp.configDir, "schedule.yaml");
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/^(\s*timezone:).*$/m, "$1 Asia/Tokyo"));
      reloadConfig("schedule");
      openFailsFor(1);
      await mutateConfig("schedule", (current) => {
        expect(current.timezone).toBe("Asia/Tokyo");
        return current;
      });
      expect(fs.readFileSync(target, "utf8")).toContain("Asia/Tokyo");
    } finally {
      temp.cleanup();
    }
  });
});
