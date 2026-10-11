/**
 * Read every stored raw posting again with the current pipeline rules, without collecting anything and
 * without AI (a cycle never needs it):
 *
 *   pnpm reprocess [--channel <id>]...
 *
 * New or improved parsing rules (work mode, German level, agency, description clean-up, salary) only
 * apply to postings that are processed after the change. Steps, in cycle order:
 *
 * 1. reset: a full run first clears the work mode, German level, contract and agency flag of the jobs, so they are
 *    rebuilt from the postings and nothing the old rules got wrong survives; the raw postings (payloads
 *    stay untouched, C1) go back to `pending`,
 * 2. `pipeline`: pending postings are processed again (jobs are updated in place),
 * 3. salaries: every job's raw postings are read again with the current salary parsing and the stored
 *    salary is corrected (the cycle's pipeline step does this once per parsing change; here it is forced),
 * 4. the hard filter evaluates every job again (a corrected salary or work mode may keep or drop a job),
 * 5. stored T1 amounts are worked out again with the current rates (no rescan), the rule signals of jobs
 *    whose JD or vocabulary changed are redone, the salary signals follow the salaries, and every score's
 *    signal bonus follows the signals,
 * 6. the German level of scores that already exist is deduced again (no AI call).
 *
 * Option `--channel <id>` (repeatable): only the postings of those channels go back to `pending`. Then the
 * reset in step 1 is skipped: the other channels' jobs keep what they have, so old wrong work mode / German /
 * agency flags stay until a full reprocess. Salaries (step 3) are re-read for all jobs either way.
 *
 * Exit code 0 = done, 1 = some postings were deferred or a rule scan failed, 2 = bad arguments.
 * DATABASE_URL decides which database; `.env` is loaded by the pnpm script.
 */
import { parseArgs } from "node:util";
import { loadPipeline } from "../src/lib/market";

import { registerBuiltinChannels } from "../src/lib/channels/builtin";
import { createLogger } from "../src/lib/channels/logger";
import { defaultRegistry } from "../src/lib/channels/registry";
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { resetRuleDerivedFacts } from "../src/lib/db/repos/jobs";
import { requeueRawPostings } from "../src/lib/db/repos/raw-postings";
import { currentPreferences, runFilter } from "../src/lib/filter";
import { refreshStoredSalaries, runPipeline } from "../src/lib/pipeline";
import { recheckGerman, readScoringProfile } from "../src/lib/scoring";
import { reconcileBonuses, revalueSignals, runRuleScan, syncSalarySignals } from "../src/lib/signals";

async function main(): Promise<number> {
  let channels: string[];
  try {
    const { values } = parseArgs({ options: { channel: { type: "string", multiple: true } }, strict: true });
    channels = values.channel ?? [];
  } catch (error) {
    console.error(`reprocess: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }

  registerBuiltinChannels(defaultRegistry);
  const db = getDb();
  const logger = createLogger({ minLevel: "warn" });
  try {
    const pipelineConfig = loadPipeline();
    const interests = loadConfig("interests");
    // Reading every posting again rebuilds these facts completely; with --channel only some postings come back,
    // so the other channels' jobs keep what they have (and old wrong flags stay until a full reprocess).
    if (channels.length === 0) console.log(`work mode, German level and agency flag cleared on ${await resetRuleDerivedFacts(db)} jobs (rebuilt from the raw postings next)`);
    const requeued = await requeueRawPostings(db, channels);
    console.log(`raw postings put back to pending: ${requeued}`);

    const pipeline = await runPipeline(db, { config: pipelineConfig, registry: defaultRegistry, logger });
    console.log(`pipeline: processed=${pipeline.processed} updated=${pipeline.updated} created=${pipeline.created} parse_failed=${pipeline.parseFailed} deferred=${pipeline.deferred}`);
    for (const f of pipeline.failures) console.log(`  raw #${f.rawPostingId} (${f.channelId}): ${f.reason}`);

    const salaries = await refreshStoredSalaries(db, { config: pipelineConfig, registry: defaultRegistry, logger, force: true });
    console.log("salaries:", JSON.stringify(salaries));

    const { preferences, snapshot } = await currentPreferences(db);
    const filter = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: pipelineConfig, logger });
    console.log("filter:", JSON.stringify({ evaluated: filter.evaluated, created: filter.created, updated: filter.updated, passed: filter.passed, filteredOut: filter.filteredOut, byReason: filter.byReason }));

    const revalued = await revalueSignals(db, { interests, pipeline: pipelineConfig, batchSize: pipelineConfig.batch_size, force: true });
    console.log("amounts revalued:", JSON.stringify(revalued));
    const scan = await runRuleScan(db, { interests, pipeline: pipelineConfig, logger, batchSize: pipelineConfig.batch_size });
    console.log("rule scan:", JSON.stringify(scan));
    const salarySignals = await syncSalarySignals(db, { interests, pipeline: pipelineConfig, logger, batchSize: pipelineConfig.batch_size });
    console.log("salary signals:", JSON.stringify(salarySignals));
    const bonus = await reconcileBonuses(db, interests);
    console.log("bonus:", JSON.stringify(bonus));

    const profile = await readScoringProfile();
    const german = await recheckGerman(db, { me: profile.me, penalties: loadConfig("ai").scoring.language_penalty, bonusCap: interests.bonus_cap, pipeline: pipelineConfig });
    console.log(`german level of scored jobs: checked=${german.checked} updated=${german.updated}`);
    return pipeline.deferred > 0 || scan.failed > 0 ? 1 : 0;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`reprocess: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
