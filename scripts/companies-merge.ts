/**
 * Find duplicate company rows and merge the ones you confirm (docs/extraction.md, "Merging duplicate companies").
 *
 *   pnpm companies:merge --suggest [--tier 1|2]            list candidates, in the plan file's format
 *   pnpm companies:merge --pair FROM:INTO ... [--apply]    dry run, or merge
 *   pnpm companies:merge --plan FILE [--apply]             the same from a plan file
 *   pnpm companies:merge --undo MERGE_ID [--apply]         dry run, or undo
 *   pnpm companies:merge --list                            the recorded merges
 *
 * Without `--apply` nothing is written and no lock is taken; it runs in a read-only transaction. Exit code 0 = done or nothing to do,
 * 1 = a pair failed or was refused, the cycle lock is taken, or an AI request is running, 2 = bad arguments or plan file.
 * DATABASE_URL decides which database; `.env` is loaded by the pnpm script.
 */
import { loadConfig } from "../src/lib/config";
import { runCompaniesMerge } from "../src/lib/companies/merge-run";
import { closeDb, getDb } from "../src/lib/db";
import { readGhostSettings, trustedCompanyKeys } from "../src/lib/ghost/settings";
import { getTranslator } from "../src/lib/i18n/node";
import { loadPipeline } from "../src/lib/market";

async function main(): Promise<number> {
  try {
    return await runCompaniesMerge({
      db: getDb(),
      argv: process.argv.slice(2),
      t: getTranslator("cli.companiesMerge", "cli"),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      context: () => {
        const pipeline = loadPipeline();
        return {
          pipeline,
          watchedCompanies: loadConfig("interests").watched_companies,
          excludedCompanies: loadConfig("preferences").exclude_companies,
          trustedKeys: trustedCompanyKeys(readGhostSettings().trusted_companies, pipeline),
        };
      },
    });
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`companies:merge: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
