/**
 * Real scoring smoke: score a few real postings of a database through the normal AI router
 * (claude-cli → codex-cli → API, whatever is available) and print what came back.
 *
 *   pnpm score:smoke --confirm-write <database-name> [--limit 3]
 *
 * It WRITES scores (and runs pending migrations), so point DATABASE_URL at a scratch copy, e.g.
 * `create database jobradar_smoke_copy template jobradar_smoke`, and pass the copy's name as
 * --confirm-write. The profile comes from JOB_RADAR_PROFILE_DIR (default data/profile). Keep --limit
 * small: every posting is one real AI call on the user's subscription.
 */
import { parseArgs } from "node:util";
import { loadDatabaseEnv } from "../src/lib/env";
import { loadPipeline } from "../src/lib/market";

import { eq, gte } from "drizzle-orm";

import { createLogger } from "../src/lib/channels/logger";
import { loadConfig } from "../src/lib/config";
import { currentPreferences, runFilter } from "../src/lib/filter";
import { closeDb, getDb, schema } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { createScoringDeps, runScoring } from "../src/lib/scoring";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { "confirm-write": { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: pnpm score:smoke --confirm-write <database-name> [--limit 3]");
    return 0;
  }
  const url = loadDatabaseEnv().DATABASE_URL;
  process.env.DATABASE_URL = url;
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (values["confirm-write"] !== dbName) {
    console.error(`score:smoke: this writes scores. Pass --confirm-write ${dbName} to confirm the database (use a scratch copy).`);
    return 2;
  }
  const limit = Number(values.limit ?? "3");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    console.error("score:smoke: --limit must be an integer from 1 to 20");
    return 2;
  }

  await runMigrations();
  const db = getDb();
  const logger = createLogger({ minLevel: "warn" });
  const schedule = loadConfig("schedule");
  const deps = createScoringDeps({ db, logger, timeZone: schedule.timezone });
  console.log(`database: ${dbName}   provider order for score: ${deps.router.plan("score").join(" > ")}`);

  // Scoring only takes jobs the hard filter passed: run the filter step first, as a cycle would.
  const { preferences, snapshot, me } = await currentPreferences(db);
  const filter = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: loadPipeline(), me, logger });
  console.log(`hard filter: evaluated=${filter.evaluated} passed=${filter.passed} filtered_out=${filter.filteredOut}`);

  const started = Date.now();
  const result = await runScoring(deps, { limit });
  console.log(`scored=${result.scored} failed=${result.failed} candidates=${result.candidates} stopped=${result.stopped ?? "-"} backlog=${JSON.stringify(result.backlog)} providers=${JSON.stringify(result.providers)} (${Math.round((Date.now() - started) / 1000)} s)`);
  for (const failure of result.failures) console.log(`  failed job ${failure.jobId}: ${failure.reason}`);

  const rows = await db
    .select({ s: schema.scores, title: schema.jobs.title, company: schema.companies.name, rule: schema.jobs.germanLevelRequired })
    .from(schema.scores)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.scores.jobId))
    .innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .where(gte(schema.scores.scoredAt, new Date(started)))
    .orderBy(schema.scores.scoredAt);
  for (const { s, title, company, rule } of rows) {
    console.log(`\n#${s.jobId} ${title} @ ${company}`);
    console.log(`  rank=${s.rankValue} score=${s.score} (ai ${s.aiScore} - german ${s.germanPenalty})  german: rule=${rule} ai=${s.germanLevelAi} used=${s.germanLevel} (${s.germanLevelSource})`);
    console.log(`  via ${s.provider} / ${s.model}  prompt ${s.promptVersion}`);
    console.log(`  summary_zh: ${s.summaryZh}`);
    console.log(`  summary_en: ${s.summaryEn}`);
    for (const r of s.fitReasons) console.log(`  + ${r}`);
    for (const g of s.gaps) console.log(`  - ${g}`);
  }
  return result.scored > 0 ? 0 : 1;
}

main().then(
  async (code) => {
    await closeDb();
    process.exit(code);
  },
  async (error: unknown) => {
    console.error(`score:smoke: ${error instanceof Error ? error.message : "failed"}`);
    await closeDb();
    process.exit(1);
  },
);
