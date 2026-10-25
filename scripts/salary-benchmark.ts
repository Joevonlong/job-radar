/**
 * Rebuild the salary benchmark now and print it (docs/salary.md). The pipeline step does the same after every cycle.
 *
 *   pnpm salary:benchmark [--json]
 *
 * Reading and printing live here; the logic is `src/lib/salary/benchmark.ts`.
 */
import { parseArgs } from "node:util";

import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { listSalaryBenchmarks } from "../src/lib/db/repos/salary-benchmarks";
import { getTranslator } from "../src/lib/i18n/node";
import { refreshSalaryBenchmark } from "../src/lib/salary/benchmark";
import { benchmarkJson, formatBenchmarkText } from "../src/lib/salary/benchmark-report";
import { loadBaseCurrency } from "../src/lib/signals/floor";

const t = getTranslator("salary", "cli");

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false }, help: { type: "boolean", default: false } }, strict: true });
  if (values.help) {
    console.log(t("cli.usage"));
    return 0;
  }
  const currency = loadBaseCurrency();
  if (currency === null) {
    console.error(t("cli.noCurrency"));
    return 1;
  }
  const config = loadConfig("salary");
  const db = getDb();
  try {
    const result = await refreshSalaryBenchmark(db, { config, currency });
    const rows = result ? await listSalaryBenchmarks(db) : [];
    if (values.json) {
      console.log(JSON.stringify(benchmarkJson(result, rows), null, 2));
      return 0;
    }
    console.log(formatBenchmarkText(result, rows, t));
    return 0;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
