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
 * Before step 1 the stored company and title keys are brought to the current key version (once per version; a cycle does
 * the same). Option `--split-merged`: then jobs that older keys merged by mistake (company or title names in a non-Latin
 * script, which used to key as "") are separated first: their postings of another company or title are detached and all
 * their postings go back to `pending`, so step 2 files each under its own company and title (`splitMergedJobs`).
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
import { withCycleLock } from "../src/lib/cycle/lock";
import { closeDb, getDb } from "../src/lib/db";
import { resetRuleDerivedFacts } from "../src/lib/db/repos/jobs";
import { requeueRawPostings } from "../src/lib/db/repos/raw-postings";
import { currentPreferences, runFilter } from "../src/lib/filter";
import { getTranslator } from "../src/lib/i18n/node";
import { refreshStoredIdentityKeys, refreshStoredSalaries, runPipeline, splitMergedJobsOf } from "../src/lib/pipeline";
import { recheckGerman, readScoringProfile } from "../src/lib/scoring";
import { reconcileBonuses, revalueSignals, runRuleScan, syncSalarySignals } from "../src/lib/signals";

async function main(): Promise<number> {
  let channels: string[];
  let splitMerged: boolean;
  try {
    const { values } = parseArgs({ options: { channel: { type: "string", multiple: true }, "split-merged": { type: "boolean" } }, strict: true });
    channels = values.channel ?? [];
    splitMerged = values["split-merged"] ?? false;
  } catch (error) {
    console.error(`reprocess: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }

  registerBuiltinChannels(defaultRegistry);
  const db = getDb();
  const logger = createLogger({ minLevel: "warn" });
  try {
    const locked = await withCycleLock(db, "wait", async ({ signal }) => {
      const pipelineConfig = loadPipeline();
      const relist = { minGapDays: loadConfig("jobArchive").relist.min_gap_days };
      const interests = loadConfig("interests");
      // --split-merged recomputes the keys even when this key version already did (rows a rolled-back version wrote since)
      const keys = await refreshStoredIdentityKeys(db, { config: pipelineConfig, logger, force: splitMerged, signal });
      if (!keys.ok) {
        console.error(`reprocess: the company and title keys could not be recomputed (${keys.error}); nothing was reprocessed`);
        return 1;
      }
      if (keys.result) console.log("company and title keys:", JSON.stringify(keys.result));
      if (splitMerged) {
        const split = await splitMergedJobsOf(db, { config: pipelineConfig, registry: defaultRegistry, logger, signal });
        console.log(`merged jobs: checked=${split.jobsChecked} split=${split.jobsSplit} postings detached=${split.sourcesUnlinked} postings put back to pending=${split.rawRequeued}`);
        if (split.splitWithUserState.length > 0) console.log(`  split jobs you had acted on (worth a look): ${split.splitWithUserState.join(", ")}`);
        if (split.needsReview.length > 0) console.log(getTranslator("cli.reprocess", "cli")("needsReview", { ids: split.needsReview.join(", ") }));
      }
      signal.throwIfAborted();
      // Reading every posting again rebuilds these facts completely; with --channel only some postings come back,
      // so the other channels' jobs keep what they have (and old wrong flags stay until a full reprocess).
      if (channels.length === 0) console.log(`work mode, German level and agency flag cleared on ${await resetRuleDerivedFacts(db)} jobs (rebuilt from the raw postings next)`);
      signal.throwIfAborted();
      const requeued = await requeueRawPostings(db, channels);
      console.log(`raw postings put back to pending: ${requeued}`);

      const pipeline = await runPipeline(db, { relist, config: pipelineConfig, registry: defaultRegistry, logger, signal });
      console.log(`pipeline: processed=${pipeline.processed} updated=${pipeline.updated} created=${pipeline.created} parse_failed=${pipeline.parseFailed} deferred=${pipeline.deferred}`);
      for (const f of pipeline.failures) console.log(`  raw #${f.rawPostingId} (${f.channelId}): ${f.reason}`);

      signal.throwIfAborted();
      const salaries = await refreshStoredSalaries(db, { config: pipelineConfig, registry: defaultRegistry, logger, force: true, signal });
      console.log("salaries:", JSON.stringify(salaries));

      signal.throwIfAborted();
      const { preferences, snapshot, me } = await currentPreferences(db);
      const filter = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: pipelineConfig, me, logger, signal });
      console.log("filter:", JSON.stringify({ evaluated: filter.evaluated, created: filter.created, updated: filter.updated, passed: filter.passed, filteredOut: filter.filteredOut, byReason: filter.byReason }));

      signal.throwIfAborted();
      const revalued = await revalueSignals(db, { interests, pipeline: pipelineConfig, batchSize: pipelineConfig.batch_size, force: true, signal });
      console.log("amounts revalued:", JSON.stringify(revalued));
      signal.throwIfAborted();
      const scan = await runRuleScan(db, { interests, pipeline: pipelineConfig, logger, batchSize: pipelineConfig.batch_size, signal });
      console.log("rule scan:", JSON.stringify(scan));
      signal.throwIfAborted();
      const salarySignals = await syncSalarySignals(db, { interests, pipeline: pipelineConfig, logger, batchSize: pipelineConfig.batch_size, signal });
      console.log("salary signals:", JSON.stringify(salarySignals));
      signal.throwIfAborted();
      const bonus = await reconcileBonuses(db, interests);
      console.log("bonus:", JSON.stringify(bonus));

      signal.throwIfAborted();
      const profile = await readScoringProfile();
      const german = await recheckGerman(db, { me: profile.me, penalties: loadConfig("ai").scoring.language_penalty, bonusCap: interests.bonus_cap, pipeline: pipelineConfig });
      console.log(`german level of scored jobs: checked=${german.checked} updated=${german.updated}`);
      return pipeline.deferred > 0 || scan.failed > 0 ? 1 : 0;
    });
    return locked.acquired ? locked.value : 1;
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
