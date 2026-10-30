import { currentScoresBackfill } from "../src/lib/db/current-scores-config";
/**
 * Real smoke of the weekly interest suggestions: run `runSuggest` once through the normal AI router
 * (claude-cli → codex-cli → API, whatever is available) over the jobs a database has marked interested /
 * applied / ignored, and print what it stored.
 *
 *   pnpm suggest:smoke --confirm-write <database-name>
 *
 * It WRITES `interest_suggestions` rows (and runs pending migrations), so point DATABASE_URL at a scratch
 * copy, e.g. `create database jobradar_uat_f056 template jobradar_uat`, and pass the copy's name as
 * --confirm-write. It changes no config file (suggestions are only proposals) and sends no Telegram message.
 * One run is one real AI call on the user's subscription.
 */
import { parseArgs } from "node:util";

import { loadDatabaseEnv } from "../src/lib/env";
import { createLogger } from "../src/lib/channels/logger";
import { ensureProfileFiles, loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { listSuggestions } from "../src/lib/db/repos/interest-suggestions";
import { createSuggestDeps, runSuggest } from "../src/lib/interests/suggest";
import { suggestionPayloadSchema, suggestedValue } from "../src/lib/interests/suggestion";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { "confirm-write": { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true });
  if (values.help) {
    console.log("Usage: pnpm suggest:smoke --confirm-write <database-name>");
    return 0;
  }
  const url = loadDatabaseEnv().DATABASE_URL;
  process.env.DATABASE_URL = url;
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (values["confirm-write"] !== dbName) {
    console.error(`suggest:smoke: this writes suggestions. Pass --confirm-write ${dbName} to confirm the database (use a scratch copy).`);
    return 2;
  }

  await runMigrations({ currentScoresBackfill: currentScoresBackfill() });
  await ensureProfileFiles();
  const db = getDb();
  const logger = createLogger({ minLevel: "warn" });
  const deps = { ...createSuggestDeps({ db, logger, timeZone: loadConfig("schedule").timezone }), notify: async () => "disabled" as const };
  console.log(`database: ${dbName}   provider order for suggest: ${deps.router.plan("suggest").join(" > ")}`);

  const started = Date.now();
  const summary = await runSuggest(deps);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(summary)}`);
  for (const row of await listSuggestions(db, { status: "pending", limit: 50 })) {
    const payload = suggestionPayloadSchema.safeParse(row.payloadJson);
    if (!payload.success) {
      console.log(`#${row.id} [unreadable]`);
      continue;
    }
    const p = payload.data;
    const what = p.kind === "signal_word" ? `signal word ${p.tier}` : p.kind === "watched_company" ? "watched company" : `filter ${p.action}`;
    console.log(`#${row.id} ${what}: ${suggestedValue(p)}  (confidence ${p.confidence})`);
    console.log(`   why: ${Object.entries(p.reasons).map(([lang, text]) => `${lang}: ${text}`).join(" | ")}`);
    for (const e of p.evidence) console.log(`   - job ${e.jobId} ${e.title} @ ${e.company}${e.quote ? `\n       "${e.quote}"` : ""}`);
  }
  return 0;
}

main().then(
  async (code) => {
    await closeDb();
    process.exit(code);
  },
  async (error: unknown) => {
    console.error(`suggest:smoke failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
    await closeDb();
    process.exit(1);
  },
);
