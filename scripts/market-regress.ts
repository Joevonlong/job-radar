/**
 * pnpm market:regress snapshot --out <file>
 * pnpm market:regress compare <base file> <head file>
 *
 * Regression check for the market steps (location, local language, base currency, filter, signals): `snapshot` saves
 * what the database holds for every job (derived values only: country codes, levels, flags, filter reasons, amounts
 * rounded to thousands; no titles, companies or text) to a JSON file; `compare` prints, per field, how many jobs differ
 * and, for code-valued fields, which values changed into which. Typical use: snapshot, `pnpm reprocess` with other code
 * or another market, snapshot again, compare. Reads only (the snapshot file is the only thing written).
 *
 * Exit code: 0 = done (compare: no job changed), 1 = compare found changes, 2 = bad arguments or unreadable input.
 * DATABASE_URL decides which database; `.env` is loaded by the pnpm script.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import { closeDb, getDb } from "../src/lib/db";
import { compareRegressSnapshots, renderRegressComparison, takeRegressSnapshot, type RegressSnapshot } from "../src/lib/market/regress";

const USAGE = "Usage: pnpm market:regress snapshot --out <file> | compare <base file> <head file>";

function readSnapshot(file: string): RegressSnapshot {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RegressSnapshot>;
  if (value.version !== 1 || typeof value.jobs !== "object" || value.jobs === null) throw new Error(`${file} is not a market:regress snapshot`);
  return value as RegressSnapshot;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true, strict: true });
  } catch (error) {
    console.error(`market:regress: ${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}`);
    return 2;
  }
  const [command, ...files] = parsed.positionals;
  if (command === "snapshot") {
    const out = parsed.values.out;
    if (!out || files.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const snapshot = await takeRegressSnapshot(getDb());
    fs.writeFileSync(out, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    console.log(`snapshot: ${Object.keys(snapshot.jobs).length} jobs -> ${out}`);
    return 0;
  }
  if (command === "compare" && files.length === 2 && files[0] && files[1]) {
    let base: RegressSnapshot;
    let head: RegressSnapshot;
    try {
      base = readSnapshot(files[0]);
      head = readSnapshot(files[1]);
    } catch (error) {
      console.error(`market:regress: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const comparison = compareRegressSnapshots(base, head);
    for (const line of renderRegressComparison(comparison)) console.log(line);
    return comparison.changedJobs === 0 ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

main().then(
  async (code) => {
    await closeDb();
    process.exit(code);
  },
  async (error: unknown) => {
    console.error(`market:regress: ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exit(2);
  },
);
