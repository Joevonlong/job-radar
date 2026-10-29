/** Read-only delivery inspection; the pnpm script loads the environment before this entry point. */
import { createReadOnlyDb } from "../src/lib/db/read-only-client";
import { getDeliveryRun } from "../src/lib/db/queries/deliveries";
import { deliveryTablesReady } from "../src/lib/db/repos/deliveries";
import { deliveryText, parseDeliveryArgs, showDeliveries } from "../src/lib/deliveries/cli";
import { scopeLocale } from "../src/lib/i18n/node";

async function main(): Promise<number> {
  let args;
  try {
    args = parseDeliveryArgs(process.argv.slice(2));
  } catch {
    console.error(deliveryText(scopeLocale("cli"))("usage"));
    return 2;
  }
  const t = deliveryText(scopeLocale("cli", args.lang));
  const connection = createReadOnlyDb();
  try {
    const result = await showDeliveries(args, {
      tablesReady: () => deliveryTablesReady(connection.db),
      query: (runId, payload) => getDeliveryRun(connection.db, runId, { payload }),
    }, t);
    console.log(result.output);
    return result.exitCode;
  } finally {
    await connection.close();
  }
}

process.exit(await main().catch(() => {
  // Driver errors can include bound receipt values; print only the localized operation failure.
  console.error(deliveryText(scopeLocale("cli"))("failed"));
  return 1;
}));
