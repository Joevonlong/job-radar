/**
 * Insert development data (about 20 fictional jobs, sources, cycles, runs, a few applications).
 *
 *   pnpm db:seed [--force]
 *
 * Idempotent: running it again replaces what the previous run created and leaves everything else
 * alone. Refuses to run when NODE_ENV=production unless --force. The migrations must have run
 * (`pnpm db:migrate`). `.env` is loaded by the pnpm script (node --env-file-if-exists=.env --import tsx).
 */
import { parseArgs } from "node:util";

import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { seedDatabase } from "../src/lib/db/seed";

function fail(message: string): never {
  console.error(`db:seed: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  let force = false;
  try {
    const { values } = parseArgs({ options: { force: { type: "boolean", default: false } }, strict: true });
    force = values.force === true;
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid arguments");
  }

  if (process.env.NODE_ENV === "production" && !force) {
    fail("refusing to seed with NODE_ENV=production (development and test data only). Pass --force if you really mean it.");
  }

  const { timezone } = loadConfig("schedule");
  const result = await seedDatabase(getDb(), { timezone });
  console.log(
    `db:seed: ${result.jobs} jobs (${result.sources} sources, ${result.companies} companies, ${result.applications} applications, ` +
      `${result.scores} scores, ${result.signals} signals), ${result.cycles} cycles with ${result.runs} runs` +
      (result.replacedJobs > 0 ? `; replaced ${result.replacedJobs} jobs of a previous seed` : ""),
  );
}

main()
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  })
  .finally(() => closeDb());
