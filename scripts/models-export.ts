/**
 * Write the whole model catalog (the shipped catalog with your additions merged in) as one complete models.yaml.
 *
 *   pnpm models:export --full              replace your models.yaml (data/config) with the full catalog; the old text is backed up
 *   pnpm models:export --full --stdout     print it, write nothing
 *   pnpm models:export --full --out <file> write it to another file
 *
 * Run it before going back to a version of Job Radar that is older than the models.yaml overlay: that version reads
 * your models.yaml as the whole catalog.
 */
import { parseArgs } from "node:util";

import { ConfigError, loadConfig } from "../src/lib/config";
import { renderFullModelsText, writeFullModels } from "../src/lib/config/models-overlay-write";

const USAGE = "Usage: pnpm models:export --full [--stdout | --out <file>]";

async function main(): Promise<number> {
  let values: { full?: boolean; stdout?: boolean; out?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ options: { full: { type: "boolean" }, stdout: { type: "boolean" }, out: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true }));
  } catch (error) {
    console.error(`models:export: ${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.full !== true || (values.stdout === true && values.out !== undefined)) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (values.stdout === true) {
      process.stdout.write(renderFullModelsText(loadConfig("models")));
      return 0;
    }
    const written = await writeFullModels(values.out);
    console.log(`Wrote the full model catalog to ${written.file}${written.backup ? ` (the old file is backed up at ${written.backup})` : ""}.`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`models:export: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`models:export: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
