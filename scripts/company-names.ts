/**
 * Give the companies the display names of config/sources.yaml (ats_boards) (what the pipeline step does at the start of
 * every cycle), for a database that has not run a cycle since the names were corrected.
 *
 *   pnpm company-names
 *
 * Prints how many companies were renamed or folded into another. Reads DATABASE_URL and JOB_RADAR_CONFIG_DIR like the app.
 */
import { loadCompanies } from "../src/lib/config";
import { loadPipeline } from "../src/lib/market";
import { closeDb, getDb } from "../src/lib/db";
import { syncCompanyDisplayNames } from "../src/lib/pipeline/company-names";

try {
  const result = await syncCompanyDisplayNames(getDb(), { companies: loadCompanies().companies, pipeline: loadPipeline() });
  console.log(`renamed ${result.renamed}, folded into another company ${result.merged}`);
} finally {
  await closeDb();
}
