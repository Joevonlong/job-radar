// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * sd_env_decode / sd_path_decode / sd_unit_db_url of scripts/ops/lib/ai-worker.sh are the exact inverses of the systemd
 * escaping in install-ai-worker.sh. The encoders are taken from the install script itself (sed from sd_path() to
 * sd_exec()), so the round trips test the real functions.
 */
const repo = path.resolve(import.meta.dirname, "../..");
const lib = path.join(repo, "scripts/ops/lib/ai-worker.sh");
const install = path.join(repo, "scripts/ops/install-ai-worker.sh");

let tmp = "";
let encoders = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-decode-"));
  encoders = path.join(tmp, "encoders.sh");
  const r = spawnSync("sed", ["-n", "/^sd_path()/,/^sd_exec()/p", install], { encoding: "utf8" });
  expect(r.stdout).toMatch(/^sd_path\(\)/);
  expect(r.stdout).toContain("sd_env()");
  fs.writeFileSync(encoders, r.stdout);
});
afterEach(() => {
  if (tmp && path.basename(tmp).startsWith("sd-decode-")) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

// runs in tmp, so a $(touch x) that ran would leave x there
function sh(snippet: string, ...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("/bin/bash", ["-c", `source "${encoders}"; source "${lib}"; ${snippet}`, "_", ...args], { encoding: "utf8", cwd: tmp, timeout: 20_000 });
  return { status: r.status, stdout: r.stdout };
}

const SAMPLES = [
  "postgres://u:p@127.0.0.1:5433/jobradar",
  "postgres://u:p%40ss@h:1/d?sslmode=require",
  'pa"ss\\word',
  "100% done %% %d %h",
  "trailing backslash \\",
  "$(touch ran-dollar)",
  "`touch ran-backtick`",
  "$HOME ${PATH} $$",
  "spaces  and\ttab",
  "ünïcödé / 日本",
  "",
];

describe("sd_env_decode / sd_path_decode", () => {
  it.each(SAMPLES.map((s) => [s]))("round trip of %j through sd_env and sd_path", (s) => {
    const env = sh('enc="$(sd_env "$1")"; out="$(sd_env_decode "$enc")"; rc=$?; printf "%s|%s" "$rc" "$out"', s);
    expect(env.stdout).toBe(`0|${s}`);
    const p = sh('enc="$(sd_path "$1")"; out="$(sd_path_decode "$enc")"; rc=$?; printf "%s|%s" "$rc" "$out"', s);
    expect(p.stdout).toBe(`0|${s}`);
    expect(fs.existsSync(path.join(tmp, "ran-dollar"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "ran-backtick"))).toBe(false);
  });

  it.each([["a\\nb"], ["a\\$b"], ["\\"], ["50%"], ["%d"], ["%h"], ['a"b'], ["%%%"]])("sd_env_decode refuses %j (not something sd_env writes)", (s) => {
    expect(sh('sd_env_decode "$1" >/dev/null; echo "rc=$?"', s).stdout.trim()).toBe("rc=1");
  });

  it.each([["%d"], ["50%"], ["%h/x"], ["%%%"]])("sd_path_decode refuses %j", (s) => {
    expect(sh('sd_path_decode "$1" >/dev/null; echo "rc=$?"', s).stdout.trim()).toBe("rc=1");
  });

  it("decoding never evaluates: $(…) and backticks come back literally and run nothing", () => {
    const r = sh('sd_env_decode "$1"; echo; sd_path_decode "$2"', "$(touch ran-a) `touch ran-b`", "$(touch ran-c)");
    expect(r.stdout).toBe("$(touch ran-a) `touch ran-b`\n$(touch ran-c)");
    expect(fs.readdirSync(tmp).sort()).toEqual(["encoders.sh"]);
  });
});

describe("sd_exec_decode", () => {
  it.each(SAMPLES.map((s) => [s]))("round trip of %j through a quoted sd_exec argument", (s) => {
    const r = sh('enc="\\"$(sd_exec "$1")\\""; out="$(sd_exec_decode "$enc")"; rc=$?; printf "%s|%s" "$rc" "$out"', s);
    expect(r.stdout).toBe(`0|${s}`);
    expect(fs.readdirSync(tmp).sort()).toEqual(["encoders.sh"]);
  });

  it.each([["a\\x2fb"], ["a\\057b"], ["%h/x"], ["50%"], ["$HOME"], ["${X}"], ["$"]])("refuses %j (a C escape, specifier or variable)", (s) => {
    expect(sh('sd_exec_decode "$1" >/dev/null; echo "rc=$?"', s).stdout.trim()).toBe("rc=1");
  });
});

describe("sd_unit_db_url", () => {
  const unit = (lines: string[]): string => {
    const file = path.join(tmp, "unit.service");
    fs.writeFileSync(file, `[Service]\n${lines.join("\n")}\n`);
    return file;
  };

  it.each(SAMPLES.filter((s) => s !== "").map((s) => [s]))("reads back what the install script writes: %j", (url) => {
    const enc = sh('sd_env "$1"', url).stdout;
    const file = unit(["WorkingDirectory=/x", `Environment="DATABASE_URL=${enc}"`, 'Environment="NODE_ENV=production"']);
    const r = sh('out="$(sd_unit_db_url "$1")"; rc=$?; printf "%s|%s" "$rc" "$out"', file);
    expect(r.stdout).toBe(`0|${url}`);
  });

  it.each([
    ["two DATABASE_URL lines", ['Environment="DATABASE_URL=a"', 'Environment="DATABASE_URL=b"']],
    ["no DATABASE_URL line", ['Environment="NODE_ENV=production"']],
    ["an unquoted form", ["Environment=DATABASE_URL=postgres://x"]],
    ["another key mentioning it", ['Environment="OLD_DATABASE_URL=x"']],
    ["an escape sd_env never writes", ['Environment="DATABASE_URL=a\\nb"']],
  ])("refuses a unit with %s", (_label, lines) => {
    const file = unit(lines);
    expect(sh('sd_unit_db_url "$1" >/dev/null; echo "rc=$?"', file).stdout.trim()).toBe("rc=1");
  });

  it("refuses a missing file", () => {
    expect(sh('sd_unit_db_url "$1" >/dev/null; echo "rc=$?"', path.join(tmp, "missing")).stdout.trim()).toBe("rc=1");
  });
});
