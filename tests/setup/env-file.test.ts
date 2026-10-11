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
    expect(applyEnvChanges(text, { TELEGRAM_CHAT_ID: "42", TELEGRAM_BOT_TOKEN: SECRET })).toBe(`# head\nA=1\n\nTELEGRAM_CHAT_ID=42\nexport B=2\n# TELEGRAM_BOT_TOKEN=commented\nTELEGRAM_BOT_TOKEN=${SECRET}\n`);
  });

  it("keeps one line per key (later duplicates go), null removes, CRLF and a missing final newline are handled", () => {
    expect(applyEnvChanges("X=1\r\nX=2\r\nY=3", { X: "9", Y: null })).toBe("X=9\r\n");
    expect(applyEnvChanges("", { X: "1" })).toBe("X=1\n");
    expect(applyEnvChanges("X=1\n", { X: "" })).toBe("X=\n");
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
});
