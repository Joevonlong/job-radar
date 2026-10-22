#!/usr/bin/env node
// Usage: node scripts/ops/check-node-engines.mjs <package.json>
//
// Checks the running Node (process.versions.node) against the package's
// engines.node range. Only the form ">=X.Y.Z <N" is understood; anything else is
// an error, so a range nobody checked cannot pass silently.
//
// Exit codes: 0 = in range, 1 = out of range (or the file cannot be read),
// 2 = engines.node is missing or not in the supported form.
//
// Pure JavaScript with no dependencies: the release guard, the install script and
// the Dockerfile stages all run it before anything else is installed or loaded.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RANGE_RE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * Parses ">=X.Y.Z <N". Returns null when the range is not in that form.
 * @param {string} range
 * @returns {{ min: [number, number, number], belowMajor: number } | null}
 */
export function parseEnginesRange(range) {
  const m = RANGE_RE.exec(String(range).trim());
  if (!m) return null;
  return { min: [Number(m[1]), Number(m[2]), Number(m[3])], belowMajor: Number(m[4]) };
}

/**
 * @param {string} range engines.node, e.g. ">=22.23.4 <23"
 * @param {string} version a Node version such as "22.23.4" or "v22.23.4"
 * @returns {{ ok: true } | { ok: false, reason: "unsupported-range" | "bad-version" | "out-of-range", message: string }}
 */
export function checkNodeEngines(range, version) {
  const parsed = parseEnginesRange(range);
  if (!parsed) {
    return {
      ok: false,
      reason: "unsupported-range",
      message: `engines.node "${range}" is not in the supported form ">=X.Y.Z <N"`,
    };
  }
  const v = VERSION_RE.exec(String(version));
  if (!v) {
    return { ok: false, reason: "bad-version", message: `cannot parse Node version "${version}"` };
  }
  const cur = [Number(v[1]), Number(v[2]), Number(v[3])];
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i++) cmp = cur[i] - parsed.min[i];
  if (cmp < 0 || cur[0] >= parsed.belowMajor) {
    return {
      ok: false,
      reason: "out-of-range",
      message: `Node ${cur.join(".")} does not satisfy engines.node "${range}"; install Node ${parsed.min.join(".")} or later, below ${parsed.belowMajor}`,
    };
  }
  return { ok: true };
}

function main(argv) {
  const file = argv[0];
  if (!file || argv.length > 1) {
    process.stderr.write("usage: check-node-engines.mjs <package.json>\n");
    return 2;
  }
  let range;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    range = pkg?.engines?.node;
  } catch (err) {
    process.stderr.write(`check-node-engines: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (typeof range !== "string") {
    process.stderr.write(`check-node-engines: ${file} has no engines.node\n`);
    return 2;
  }
  const result = checkNodeEngines(range, process.versions.node);
  if (result.ok) return 0;
  process.stderr.write(`check-node-engines: ${result.message}\n`);
  return result.reason === "out-of-range" ? 1 : 2;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) process.exit(main(process.argv.slice(2)));
