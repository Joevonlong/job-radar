/**
 * Run the signal extraction on real jobs and print what it found.
 *
 *   pnpm smoke:signals --jobs 3,7,37 [--no-ai]
 *
 * Works on the database DATABASE_URL points at (use a COPY: it writes signals and score bonuses).
 * The rule stage runs on every job; the AI review (the normal router: claude-cli → codex-cli → API)
 * runs only on the listed jobs, one `signals` call each. Prints, per job, the rule candidates, what
 * the AI decided and the final signals with their quotes. `.env` is loaded by the pnpm script.
 */
import { parseArgs } from "node:util";
import { loadPipeline } from "../src/lib/market";

import { createDbUsageStore } from "../src/lib/ai/usage";
import { createDefaultProviders } from "../src/lib/ai/providers";
import { createAiRouter } from "../src/lib/ai/router";
import { createLogger } from "../src/lib/channels/logger";
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb, schema } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { listSignalsOfJob } from "../src/lib/db/repos/signals";
import { findCandidates, reconcileBonuses, runAiReview, runRuleScan } from "../src/lib/signals";
import { inArray } from "drizzle-orm";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { jobs: { type: "string" }, "no-ai": { type: "boolean" } }, strict: true });
  const ids = (values.jobs ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0 && !values["no-ai"]) {
    console.error("smoke:signals: pass --jobs <id,id,...> (or --no-ai for the rule stage only)");
    return 2;
  }
  await runMigrations();
  const db = getDb();
  const interests = loadConfig("interests");
  const pipeline = loadPipeline();
  const logger = createLogger({ sink: () => {} });

  const scan = await runRuleScan(db, { interests, pipeline, logger, batchSize: pipeline.batch_size });
  console.log(`rule scan: ${JSON.stringify(scan)}`);

  const jobs = ids.length > 0 ? await db.select().from(schema.jobs).where(inArray(schema.jobs.id, ids)) : [];
  for (const job of jobs) {
    const candidates = findCandidates(job.description ?? "", interests, pipeline);
    console.log(`\n=== job ${job.id}: ${job.title}`);
    console.log(`  rule candidates (${candidates.length}):`);
    for (const c of candidates) {
      console.log(`    ${c.tier}${c.aiConfirmOnly ? " (needs AI)" : ""} ${c.kind}${c.value ? ` ${c.value.min ?? ""}-${c.value.max ?? ""} ${c.value.currency}/yr` : ""} | ${JSON.stringify(c.quote.slice(0, 140))}`);
    }
  }

  if (!values["no-ai"]) {
    const config = loadConfig("ai");
    const router = createAiRouter({ config, providers: createDefaultProviders(config), usage: createDbUsageStore(db), logger });
    console.log(`\nAI plan for task "signals": ${router.plan("signals").join(" → ")}`);
    const review = await runAiReview(db, { router, interests, pipeline, logger, limit: ids.length, jobIds: ids });
    console.log(`AI review: reviewed=${review.reviewed} failed=${review.failed} skipped=${review.skipped} stopped=${review.stopped} providers=${JSON.stringify(review.providers)}`);
    console.log(`AI stats: ${JSON.stringify(review.stats)}`);
    for (const j of review.jobs) console.log(`  job ${j.jobId}: ${j.provider}/${j.model} ${JSON.stringify(j.stats)}`);
  }

  const bonus = await reconcileBonuses(db, interests);
  console.log(`\nbonus: ${JSON.stringify(bonus)}`);
  for (const job of jobs) {
    console.log(`\n--- final signals of job ${job.id}: ${job.title}`);
    for (const s of await listSignalsOfJob(db, job.id)) {
      const v = s.value && typeof s.value === "object" ? JSON.stringify(s.value) : "";
      console.log(`  ${s.tier} ${s.kind} [${s.extractor}] ${v}\n      “${s.quote}”`);
    }
    const [row] = await db.select().from(schema.scores).where(inArray(schema.scores.jobId, [job.id]));
    console.log(`  → scores: signal_bonus=${row?.signalBonus ?? "-"} rank_value=${row?.rankValue ?? "-"}`);
  }
  await closeDb();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`smoke:signals: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
