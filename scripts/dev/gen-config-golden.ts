/**
 * Generate the golden effective configs: `tests/fixtures/config/golden/<set>.json`, one per input set, holding for every
 * config file where it is read from and the canonical hash of its effective value, plus the commit that produced them. `tests/config/golden.test.ts` checks that the current loader gives the same hashes.
 *
 * Input sets (from `--inputs`, a copy of `tests/fixtures/config`): `defaults` = the shipped defaults with no user file;
 * one set per directory of `full/` (a user config directory over the defaults; its `profile/`, when present, is the
 * profile directory).
 *
 * The point is to take the hashes with an OLDER loader (the merge base of the change), not the one under test. Run it
 * on a separate checkout of that commit, with this script and the two files it needs copied there:
 *
 *   git worktree add --detach <tmp> <base>
 *   mkdir -p <tmp>/scripts/dev
 *   cp scripts/dev/gen-config-golden.ts <tmp>/scripts/dev/
 *   cp src/lib/config/canonical-hash.ts src/lib/config/effective-report.ts <tmp>/src/lib/config/
 *   ln -s "$PWD/node_modules" <tmp>/node_modules   # same lockfile
 *   (cd <tmp> && node --import tsx scripts/dev/gen-config-golden.ts --inputs "$PWD/tests/fixtures/config" --out "$PWD/tests/fixtures/config/golden")
 *   git worktree remove --force <tmp>
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectiveConfigEntries } from "../../src/lib/config/effective-report";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(`usage: gen-config-golden.ts --inputs <fixture dir> --out <golden dir>  (missing ${name})`);
    process.exit(2);
  }
  return path.resolve(value);
}

const inputs = arg("--inputs");
const out = arg("--out");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "config-golden-"));
const fullDir = path.join(inputs, "full");
const sets = [
  { set: "defaults", user: path.join(empty, "config"), profile: path.join(empty, "profile") },
  ...fs
    .readdirSync(fullDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((set) => {
      const user = path.join(fullDir, set);
      const profile = path.join(user, "profile");
      return { set, user, profile: fs.existsSync(profile) ? profile : path.join(empty, "profile") };
    }),
];

fs.mkdirSync(out, { recursive: true });
for (const { set, user, profile } of sets) {
  process.env.JOB_RADAR_DEFAULTS_DIR = path.join(inputs, "defaults");
  process.env.JOB_RADAR_CONFIG_DIR = user;
  process.env.JOB_RADAR_PROFILE_DIR = profile;
  const files: Record<string, { layer: string; hash: string | null; valid: boolean }> = {};
  // no error text: it holds machine-specific paths
  for (const entry of effectiveConfigEntries()) files[entry.name] = { layer: entry.layer, hash: entry.hash, valid: entry.error === null };
  const file = path.join(out, `${set}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ sha, set, files }, null, 2)}\n`);
  const failed = Object.entries(files).filter(([, entry]) => !entry.valid && entry.layer !== "missing").map(([name]) => name);
  console.log(`${set}: ${Object.keys(files).length} files${failed.length > 0 ? `, invalid: ${failed.join(", ")}` : ""} -> ${file}`);
}
fs.rmSync(empty, { recursive: true, force: true });
