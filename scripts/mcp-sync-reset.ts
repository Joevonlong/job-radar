import { parseArgs } from "node:util";

import { closeDb, getDb } from "../src/lib/db/client";
import { resetAgentChanges } from "../src/lib/db/repos/agent-changes";
import { getTranslator } from "../src/lib/i18n/node";

const t = getTranslator("cli.mcpSyncReset", "cli");

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { yes: { type: "boolean" } }, strict: true, allowPositionals: false });
  if (!values.yes) {
    console.error(t("confirm"));
    return 1;
  }
  try {
    console.log(await resetAgentChanges(getDb()));
    return 0;
  } finally {
    await closeDb();
  }
}

try {
  process.exitCode = await main();
} catch {
  console.error(t("failed"));
  process.exitCode = 1;
}
