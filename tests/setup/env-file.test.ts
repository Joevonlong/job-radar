// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEnvChanges, updateEnvFile } from "@/lib/setup/env-file";

const SECRET = "123456:FAKE-env-file-secret";

describe("applyEnvChanges", () => {
  it("changes only the given keys; other lines, comments, blank lines and the order stay", () => {
    const text = "# head\nA=1\n\nTELEGRAM_CHAT_ID=old # note\nexport B=2\n# TELEGRAM_BOT_TOKEN=commented\n";
    expect(applyEnvChanges(text, { TELEGRAM_CHAT_ID: "42", TELEGRAM_BOT_TOKEN: SECRET })).toBe(`# head\nA=1\n\nTELEGRAM_CHAT_ID=42 # note\nexport B=2\n# TELEGRAM_BOT_TOKEN=commented\nTELEGRAM_BOT_TOKEN=${SECRET}\n`);
  });

  it("keeps one line per key (later duplicates go), null removes, CRLF and a missing final newline are handled", () => {
    expect(applyEnvChanges("X=1\r\nX=2\r\nY=3", { X: "9", Y: null })).toBe("X=9\r\n");
    expect(applyEnvChanges("", { X: "1" })).toBe("X=1\n");
    expect(applyEnvChanges("X=1\n", { X: "" })).toBe("X=\n");
  });

  it("keeps an export prefix and a trailing inline comment of the line it rewrites", () => {
    expect(applyEnvChanges("export TELEGRAM_CHAT_ID=old\n", { TELEGRAM_CHAT_ID: "42" })).toBe("export TELEGRAM_CHAT_ID=42\n");
    expect(applyEnvChanges("  export X = old   # keep me\n", { X: "1" })).toBe("  export X=1   # keep me\n");
    expect(applyEnvChanges('X="a # not a comment" # real\n', { X: "1" })).toBe("X=1 # real\n");
    expect(applyEnvChanges("X='old'\n", { X: "1" })).toBe("X=1\n");
    expect(applyEnvChanges("X= # empty with a note\n", { X: "1" })).toBe("X=1 # empty with a note\n");
    expect(applyEnvChanges("X=a#b\n", { X: "1" })).toBe("X=1\n");
  });

  it("refuses values that would need quoting, without echoing them", () => {
    expect(() => applyEnvChanges("", { X: "a b" })).toThrow(/X/);
    expect(() => applyEnvChanges("", { X: "line\nbreak" })).not.toThrow(/line/);
    expect(() => applyEnvChanges("", { "1BAD": "x" })).toThrow();
  });
});

describe("updateEnvFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-envfile-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("backs up the old file (0600), writes atomically and leaves the result 0600", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "A=1\nTELEGRAM_BOT_TOKEN=\n", { mode: 0o644 });
    const result = updateEnvFile({ file, changes: { TELEGRAM_BOT_TOKEN: SECRET }, now: new Date("2026-10-11T08:09:10.123Z") });
    expect(result).toEqual({ file, backup: `${file}.backup-20261011T080910Z`, created: false });
    expect(fs.readFileSync(file, "utf8")).toBe(`A=1\nTELEGRAM_BOT_TOKEN=${SECRET}\n`);
    expect(fs.readFileSync(result.backup ?? "", "utf8")).toBe("A=1\nTELEGRAM_BOT_TOKEN=\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.backup ?? "").mode & 0o777).toBe(0o600);
    // nothing temporary left behind
    expect(fs.readdirSync(dir).sort()).toEqual([".env", ".env.backup-20261011T080910Z"]);
    // a second write in the same second gets its own backup
    expect(updateEnvFile({ file, changes: { A: "2" }, now: new Date("2026-10-11T08:09:10.500Z") }).backup).toBe(`${file}.backup-20261011T080910Z-2`);
  });

  it("creates a missing .env from .env.example, or from nothing", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(path.join(dir, ".env.example"), "# keys\nTELEGRAM_CHAT_ID=\nOTHER=\n");
    expect(updateEnvFile({ file, changes: { TELEGRAM_CHAT_ID: "7" } })).toEqual({ file, backup: null, created: true });
    expect(fs.readFileSync(file, "utf8")).toBe("# keys\nTELEGRAM_CHAT_ID=7\nOTHER=\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const bare = path.join(dir, "sub");
    fs.mkdirSync(bare);
    updateEnvFile({ file: path.join(bare, ".env"), changes: { X: "1" } });
    expect(fs.readFileSync(path.join(bare, ".env"), "utf8")).toBe("X=1\n");
  });

  it("a refused value changes nothing and names no value", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "A=1\n");
    expect(() => updateEnvFile({ file, changes: { A: `${SECRET} x` } })).toThrow(/^(?![\s\S]*FAKE)/);
    expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
    expect(fs.readdirSync(dir)).toEqual([".env"]);
  });

  it("writes through a symlinked .env: the link stays, its target changes", () => {
    const real = path.join(dir, "secrets.env");
    fs.writeFileSync(real, "A=1\nTELEGRAM_CHAT_ID=old\n", { mode: 0o600 });
    const link = path.join(dir, ".env");
    fs.symlinkSync("secrets.env", link);
    const result = updateEnvFile({ file: link, changes: { TELEGRAM_CHAT_ID: "42" } });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("A=1\nTELEGRAM_CHAT_ID=42\n");
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    expect(result.backup).not.toBeNull();
    expect(fs.readFileSync(result.backup as string, "utf8")).toBe("A=1\nTELEGRAM_CHAT_ID=old\n");
  });

  it("a link to a file that does not exist yet creates the target from the example", () => {
    fs.writeFileSync(path.join(dir, ".env.example"), "TELEGRAM_CHAT_ID=\n");
    const link = path.join(dir, ".env");
    fs.symlinkSync("later.env", link);
    const result = updateEnvFile({ file: link, changes: { TELEGRAM_CHAT_ID: "42" } });
    expect(result.created).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "later.env"), "utf8")).toBe("TELEGRAM_CHAT_ID=42\n");
  });
});
