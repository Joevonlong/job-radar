/**
 * The order in which waiting jobs would be scored, and an optional backlog run.
 *
 *   pnpm score:queue [--limit 20] [--order priority|newest]
 *   pnpm score:queue --run 5 --confirm-write <database-name>
 *
 * Without --run it only reads: it prints the first N jobs that wait for an AI score, either in the new
 * priority order (ai.yaml `scoring.priority`, the default) or in the old newest-first order, with the
 * pre-score components. With --run N it scores the N most relevant never-scored jobs through the real
 * AI router (claude-cli -> codex-cli -> API) and prints the scores; that WRITES scores, so point
 * DATABASE_URL at a scratch copy and pass its name as --confirm-write. The profile comes from
 * JOB_RADAR_PROFILE_DIR (default data/profile).
 */
import { parseArgs } from "node:util";

import { inArray } from "drizzle-orm";


import { createLogger } from "../src/lib/channels/logger";
import { loadConfig } from "../src/lib/config";
import { loadDatabaseEnv } from "../src/lib/env";
import { closeDb, getDb, schema } from "../src/lib/db";
import { buildScoreQueue, createScoringDeps, currentPreferencesSnapshotId, readScoringProfile, scoreBacklog } from "../src/lib/scoring";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      order: { type: "string" },
      run: { type: "string" },
      "confirm-write": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: pnpm score:queue [--limit 20] [--order priority|newest] | --run <n> --confirm-write <database-name>");
    return 0;
  }
  const url = loadDatabaseEnv().DATABASE_URL;
  process.env.DATABASE_URL = url;
  const dbName = new URL(url).pathname.replace(/^\//, "");
  const limit = Number(values.limit ?? "20");
  const order = values.order ?? "priority";
  if (!Number.isInteger(limit) || limit < 1 || (order !== "priority" && order !== "newest")) {
    console.error("score:queue: --limit must be a positive integer and --order priority or newest");
    return 2;
  }

  const db = getDb();
  const logger = createLogger({ minLevel: "warn" });
  const deps = createScoringDeps({ db, logger, timeZone: loadConfig("schedule").timezone });
  const profile = await readScoringProfile();
  const snapshotId = await currentPreferencesSnapshotId(db, profile);

  if (values.run !== undefined) {
    const n = Number(values.run);
    if (values["confirm-write"] !== dbName) {
      console.error(`score:queue: --run scores jobs for real. Pass --confirm-write ${dbName} to confirm the database (use a scratch copy).`);
      return 2;
    }
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      console.error("score:queue: --run must be an integer from 1 to 20 (every job is a real AI call)");
      return 2;
    }
    const started = Date.now();
    const queued = (await buildScoreQueue(deps, profile, snapshotId, { only: "new" })).slice(0, n);
    const result = await scoreBacklog(deps, { limit: n });
    console.log(`database: ${dbName}  scored=${result.scored} failed=${result.failed} stopped=${result.stopped ?? "-"} backlog=${JSON.stringify(result.backlog)} providers=${JSON.stringify(result.providers)} (${Math.round((Date.now() - started) / 1000)} s)`);
    const rows = await db.select().from(schema.scores).where(inArray(schema.scores.jobId, queued.map((q) => q.jobId)));
    for (const q of queued) {
      const s = rows.find((r) => r.jobId === q.jobId && r.profileSnapshotId === snapshotId);
      console.log(`#${q.jobId} pre=${q.breakdown.priority.toFixed(1)}  ${q.title} @ ${q.company}  ->  ${s?.score === null || s === undefined ? "not scored" : `score ${s.score} (ai ${s.aiScore}, german -${s.germanPenalty}) rank ${s.rankValue} via ${s.provider}`}`);
      if (s?.summaryZh) console.log(`      ${s.summaryZh}`);
    }
    return 0;
  }

  const all = await buildScoreQueue(deps, profile, snapshotId);
  const rows = order === "priority" ? all : [...all].sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || b.jobId - a.jobId);
  console.log(`database: ${dbName}  waiting=${all.length}  order=${order}`);
  for (const [i, r] of rows.slice(0, limit).entries()) {
    const b = r.breakdown;
    console.log(
      `${String(i + 1).padStart(2)}. #${r.jobId} pre=${b.priority.toFixed(1).padStart(5)} (title ${b.title.toFixed(2)} sig ${b.signals.toFixed(2)} loc ${b.location.toFixed(2)} sen ${b.seniority.toFixed(2)} rec ${b.recency.toFixed(2)} lang -${b.languageGap.toFixed(2)})${r.hasScore ? " [stale]" : ""}  ${r.title} @ ${r.company}`,
    );
  }
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
