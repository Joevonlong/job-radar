// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * Every scripts/ops/*.sh prints its header comment for `--help` (line 2 up to the first line that is not a comment), and that
 * text names every option the script's argument loop accepts: a header that grows can no longer cut options off the help.
 */
const OPS = path.resolve(import.meta.dirname, "../../scripts/ops");

/** Scripts without options of their own: pg-docker.sh hands every argument to pg_dump / pg_restore. */
const PASSTHROUGH = new Set(["pg-docker.sh"]);

/** The options of the `while [[ $# -gt 0 ]]` argument loop (`--root)`, `-h|--help)`, `--level=*)`), without `-h` / `--help`. */
function parsedOptions(script: string): string[] {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => /^\s*while \[\[ \$# -gt 0 \]\]/.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^\s*done\b/.test(line));
  const option = String.raw`(?:-[A-Za-z0-9]|--[a-z0-9][a-z0-9-]*)(?:=\*)?`;
  const pattern = new RegExp(String.raw`^\s*(${option}(?:\s*\|\s*${option})*)\)`);
  const found = new Set<string>();
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    const match = pattern.exec(line);
    if (!match?.[1]) continue;
    for (const alternative of match[1].split("|")) found.add(alternative.trim().replace(/=\*$/, ""));
  }
  found.delete("-h");
  found.delete("--help");
  return [...found].sort();
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The options of `script` that its `--help` output does not name. */
function missingFromHelp(options: readonly string[], help: string): string[] {
  return options.filter((option) => !new RegExp(String.raw`(?<![\w-])${escapeRegex(option)}(?![\w-])`).test(help));
}

function help(file: string): { status: number | null; stdout: string; stderr: string } {
  // HOME points at an empty directory: nothing a script might read before it parses its arguments is the real one.
  const out = spawnSync("bash", [file, "--help"], { encoding: "utf8", env: { ...process.env, HOME: tmp() }, timeout: 20_000 });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

let tmpDir = "";
function tmp(): string {
  if (tmpDir === "") tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-help-"));
  return tmpDir;
}
afterAll(() => {
  if (tmpDir !== "") fs.rmSync(tmpDir, { recursive: true, force: true });
});

const scripts = fs
  .readdirSync(OPS)
  .filter((name) => name.endsWith(".sh"))
  .sort();

describe("scripts/ops/*.sh --help", () => {
  it("finds the scripts", () => {
    expect(scripts).toEqual(expect.arrayContaining(["backup.sh", "deploy.sh", "install-ai-worker.sh", "restore.sh", "uninstall-ai-worker.sh"]));
  });

  it.each(scripts.filter((name) => !PASSTHROUGH.has(name)))("%s: --help names every option it parses", (name) => {
    const file = path.join(OPS, name);
    const options = parsedOptions(fs.readFileSync(file, "utf8"));
    expect(options.length).toBeGreaterThan(0);
    const out = help(file);
    expect(out.status, out.stderr).toBe(0);
    expect(missingFromHelp(options, out.stdout)).toEqual([]);
    // the header only: nothing after the first line that is not a comment
    expect(out.stdout).not.toContain("set -euo pipefail");
    expect(out.stdout.split("\n")[0]).not.toMatch(/^#!/);
  });

  it.each([...PASSTHROUGH])("%s has no options of its own", (name) => {
    expect(parsedOptions(fs.readFileSync(path.join(OPS, name), "utf8"))).toEqual([]);
  });
});

describe("the help check itself", () => {
  const fixture = [
    "#!/usr/bin/env bash",
    "# Does a thing.",
    "#",
    "#   fixture.sh [--alpha] [--beta-gamma N]",
    "#",
    "#   --alpha        first",
    "set -euo pipefail",
    "# not part of the help",
    `usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "\${BASH_SOURCE[0]}"; }`,
    "while [[ $# -gt 0 ]]; do",
    '  case "$1" in',
    "    --alpha) shift ;;",
    "    --beta-gamma) shift 2 ;;",
    "    --delta|-d) shift ;;",
    "    --level=*) shift ;;",
    "    -h|--help) usage; exit 0 ;;",
    '    -*) echo "unknown option: $1" >&2; exit 2 ;;',
    "  esac",
    "done",
    "case \"$x\" in",
    "  --not-an-option) ;;",
    "esac",
    "",
  ].join("\n");

  it("collects the options of the argument loop only", () => {
    expect(parsedOptions(fixture)).toEqual(["--alpha", "--beta-gamma", "--delta", "--level", "-d"]);
  });

  it("prints line 2 up to the first line that is not a comment, and reports what it leaves out", () => {
    const file = path.join(tmp(), "fixture.sh");
    fs.writeFileSync(file, fixture, { mode: 0o755 });
    const out = help(file);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(["Does a thing.", "", "  fixture.sh [--alpha] [--beta-gamma N]", "", "  --alpha        first", ""].join("\n"));
    expect(missingFromHelp(parsedOptions(fixture), out.stdout)).toEqual(["--delta", "--level", "-d"]);
  });

  it("matches whole options only", () => {
    expect(missingFromHelp(["--ref", "--no-backup"], "  --remote NAME  --no-backups")).toEqual(["--ref", "--no-backup"]);
  });
});
