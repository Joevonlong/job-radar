/**
 * Re-run the hard filter over the jobs already in the database (no collecting, no AI), e.g. after
 * the location rules or `config/pipeline.yaml: filter` changed.
 *
 *   pnpm refilter [--dry-run] [--job <id>]...
 *
 * Prints the pass / filter counts before and after, how often each reason applies, and the results
 * of the requested jobs. Without --dry-run the new results are written, like the cycle's `filter`
 * step. Reads DATABASE_URL, JOB_RADAR_CONFIG_DIR and JOB_RADAR_PROFILE_DIR like the app.
 */
import { parseArgs } from "node:util";
import { loadPipeline } from "../src/lib/market";

import { eq } from "drizzle-orm";

import { closeDb, getDb, getFilterOverrides, listFilterCandidates, schema } from "../src/lib/db";
import { compileFilter, currentPreferences, evaluateBatch, runFilter, vmTimeBox } from "../src/lib/filter";
import { startDealBreakerRun } from "../src/lib/filter/deal-breakers";

interface Tally {
  passed: number;
  filtered: number;
  byCode: Map<string, number>;
}

const emptyTally = (): Tally => ({ passed: 0, filtered: 0, byCode: new Map() });

function add(tally: Tally, result: string, reasons: readonly string[]): void {
  if (result === "passed") tally.passed += 1;
  else tally.filtered += 1;
  for (const reason of reasons) {
    const code = reason.split(":", 1)[0] ?? reason;
    tally.byCode.set(code, (tally.byCode.get(code) ?? 0) + 1);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, job: { type: "string", multiple: true } }, strict: true });
  const db = getDb();
  const pipeline = loadPipeline();
  const { preferences, snapshot, me } = await currentPreferences(db);
  const jobIds = (values.job ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);

  const stored = new Map<number, { result: string; reasons: string[] }>();
  const before = emptyTally();
  for (const row of await db.select().from(schema.scores).where(eq(schema.scores.profileSnapshotId, snapshot.id))) {
    stored.set(row.jobId, { result: row.filterResult, reasons: row.filterReasons });
    add(before, row.filterResult, row.filterReasons);
  }

  const now = new Map(stored);
  if (values["dry-run"]) {
    console.log("dry run: nothing written");
    const compiled = compileFilter(preferences, pipeline, { me });
    const dealBreakers = startDealBreakerRun(compiled.dealBreakers, vmTimeBox);
    now.clear();
    for (let afterId = 0; ; ) {
      const batch = await listFilterCandidates(db, { afterId, limit: 200 });
      if (batch.length === 0) break;
      afterId = batch[batch.length - 1]?.id ?? afterId;
      const overrides = await getFilterOverrides(db, batch.map((j) => j.id));
      const verdicts = evaluateBatch(batch, compiled, dealBreakers, overrides);
      batch.forEach((row, i) => {
        const verdict = verdicts[i];
        if (verdict) now.set(row.id, { result: verdict.result, reasons: verdict.reasons });
      });
    }
    for (const warning of [...compiled.dealBreakers.warnings, ...dealBreakers.warnings]) console.log(`deal-breaker ${warning.id} not applied: ${warning.code}`);
  } else {
    const run = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline, me });
    console.log(`updated ${run.updated}, created ${run.created}, unchanged ${run.unchanged}`);
    for (const warning of run.dealBreakerWarnings) console.log(`deal-breaker ${warning.id} not applied: ${warning.code}`);
    for (const row of await db.select().from(schema.scores).where(eq(schema.scores.profileSnapshotId, snapshot.id))) now.set(row.jobId, { result: row.filterResult, reasons: row.filterReasons });
  }
  const after = emptyTally();
  for (const { result, reasons } of now.values()) add(after, result, reasons);

  console.log(`before: ${before.passed} passed, ${before.filtered} filtered`);
  console.log(`after:  ${after.passed} passed, ${after.filtered} filtered`);
  for (const code of new Set([...before.byCode.keys(), ...after.byCode.keys()]).values()) {
    console.log(`  ${code.padEnd(26)} ${String(before.byCode.get(code) ?? 0).padStart(4)} -> ${String(after.byCode.get(code) ?? 0).padStart(4)}`);
  }
  for (const jobId of jobIds) {
    const was = stored.get(jobId);
    const is = now.get(jobId);
    console.log(`job ${jobId}: ${was ? `${was.result} ${JSON.stringify(was.reasons)}` : "-"}  =>  ${is ? `${is.result} ${JSON.stringify(is.reasons)}` : "-"}`);
  }
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(`refilter: ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 1;
  });
