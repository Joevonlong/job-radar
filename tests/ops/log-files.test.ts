// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AI_WORKER_LOG_NAMES, redirectOutputToFiles, rotateLogFile } from "@/lib/ops/log-files";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-files-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (file: string): string => fs.readFileSync(file, "utf8");
const names = (): string[] => fs.readdirSync(dir).sort();

describe("rotateLogFile (copy-truncate)", () => {
  it("leaves a file at or under the limit alone, and a missing file is no error", () => {
    const file = path.join(dir, "a.log");
    fs.writeFileSync(file, "12345");
    expect(rotateLogFile(file, 5, 3)).toBe(false);
    expect(read(file)).toBe("12345");
    expect(rotateLogFile(path.join(dir, "missing.log"), 5, 3)).toBe(false);
  });

  it("copies an oversized file to .1, shifts the older copies and empties the file in place", () => {
    const file = path.join(dir, "a.log");
    fs.writeFileSync(`${file}.1`, "older");
    fs.writeFileSync(`${file}.2`, "oldest");
    fs.writeFileSync(file, "current-content");
    const inode = fs.statSync(file).ino;
    expect(rotateLogFile(file, 5, 3)).toBe(true);
    expect(read(file)).toBe("");
    expect(fs.statSync(file).ino).toBe(inode); // same file: a writer holding it open carries on
    expect(read(`${file}.1`)).toBe("current-content");
    expect(read(`${file}.2`)).toBe("older");
    expect(read(`${file}.3`)).toBe("oldest");
  });

  it("keeps at most `keep` copies and removes copies left over from a larger keep", () => {
    const file = path.join(dir, "a.log");
    for (const n of [1, 2, 3, 4, 5]) fs.writeFileSync(`${file}.${n}`, `copy${n}`);
    fs.writeFileSync(path.join(dir, "a.log.legacy"), "not a numbered copy");
    fs.writeFileSync(file, "x".repeat(20));
    rotateLogFile(file, 10, 2);
    expect(names()).toEqual(["a.log", "a.log.1", "a.log.2", "a.log.legacy"]);
    expect(read(`${file}.1`)).toBe("x".repeat(20));
    expect(read(`${file}.2`)).toBe("copy1");
  });

  it("keep 0 only empties the file", () => {
    const file = path.join(dir, "a.log");
    fs.writeFileSync(file, "x".repeat(20));
    fs.writeFileSync(`${file}.1`, "old");
    expect(rotateLogFile(file, 10, 0)).toBe(true);
    expect(names()).toEqual(["a.log"]);
    expect(read(file)).toBe("");
  });

  it("puts the copies into archiveDir (launchd's internal-disk file -> the external volume), emptying the file in place", () => {
    const internal = path.join(dir, "internal");
    const external = path.join(dir, "external");
    fs.mkdirSync(internal);
    fs.mkdirSync(external);
    const file = path.join(internal, "ai-worker.launchd.log");
    fs.writeFileSync(path.join(external, "ai-worker.launchd.log.1"), "earlier crash");
    fs.writeFileSync(file, "x".repeat(20));
    expect(rotateLogFile(file, 10, 3, external)).toBe(true);
    expect(fs.readdirSync(internal)).toEqual(["ai-worker.launchd.log"]);
    expect(read(file)).toBe("");
    expect(read(path.join(external, "ai-worker.launchd.log.1"))).toBe("x".repeat(20));
    expect(read(path.join(external, "ai-worker.launchd.log.2"))).toBe("earlier crash");
  });

  it("an append-mode writer continues at the start of the emptied file", () => {
    const file = path.join(dir, "a.log");
    const fd = fs.openSync(file, "a");
    fs.writeSync(fd, "before rotation, long enough\n");
    rotateLogFile(file, 5, 1);
    fs.writeSync(fd, "after\n");
    fs.closeSync(fd);
    expect(read(file)).toBe("after\n");
    expect(read(`${file}.1`)).toBe("before rotation, long enough\n");
  });
});

/** A stand-in for process.stdout / stderr that records what reaches the original stream. */
function fakeStream(): { stream: { write: (...args: unknown[]) => boolean }; received: string[] } {
  const received: string[] = [];
  return {
    received,
    stream: {
      write: (...args: unknown[]) => {
        received.push(String(args[0]));
        return true;
      },
    },
  };
}

describe("redirectOutputToFiles", () => {
  it("creates the directory and appends stdout / stderr to the two files instead of the streams", async () => {
    const out = fakeStream();
    const err = fakeStream();
    const logDir = path.join(dir, "data", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, AI_WORKER_LOG_NAMES.out), "earlier run\n");
    const output = redirectOutputToFiles(logDir, { stdout: out.stream as unknown as NodeJS.WriteStream, stderr: err.stream as unknown as NodeJS.WriteStream });
    try {
      out.stream.write("hello\n");
      out.stream.write(Buffer.from("bytes\n"));
      err.stream.write("oops\n", "utf8");
      let called = false;
      out.stream.write("with callback\n", () => {
        called = true;
      });
      expect(out.received).toEqual([]);
      expect(err.received).toEqual([]);
      expect(output.files).toEqual({ out: path.join(logDir, AI_WORKER_LOG_NAMES.out), err: path.join(logDir, AI_WORKER_LOG_NAMES.err) });
      expect(output.dir).toBe(logDir);
      expect(read(output.files.out)).toBe("earlier run\nhello\nbytes\nwith callback\n");
      expect(read(output.files.err)).toBe("oops\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect(called).toBe(true);
    } finally {
      output.restore();
    }
  });

  it("rotates its own files by size and keeps writing to the emptied file", () => {
    const out = fakeStream();
    const err = fakeStream();
    const output = redirectOutputToFiles(dir, { stdout: out.stream as unknown as NodeJS.WriteStream, stderr: err.stream as unknown as NodeJS.WriteStream });
    try {
      out.stream.write("x".repeat(100));
      expect(output.rotate(50, 2)).toEqual([output.files.out]);
      out.stream.write("fresh\n");
      expect(read(output.files.out)).toBe("fresh\n");
      expect(read(`${output.files.out}.1`)).toBe("x".repeat(100));
    } finally {
      output.restore();
    }
  });

  it("restore() puts the original write back", () => {
    const out = fakeStream();
    const err = fakeStream();
    const original = out.stream.write;
    const output = redirectOutputToFiles(dir, { stdout: out.stream as unknown as NodeJS.WriteStream, stderr: err.stream as unknown as NodeJS.WriteStream });
    output.restore();
    expect(out.stream.write).toBe(original);
    out.stream.write("back to the stream\n");
    expect(out.received).toEqual(["back to the stream\n"]);
  });

  it("throws when the directory cannot be created, leaving the streams untouched", () => {
    const out = fakeStream();
    const err = fakeStream();
    const original = out.stream.write;
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "");
    expect(() => redirectOutputToFiles(path.join(blocker, "logs"), { stdout: out.stream as unknown as NodeJS.WriteStream, stderr: err.stream as unknown as NodeJS.WriteStream })).toThrow();
    expect(out.stream.write).toBe(original);
  });
});
