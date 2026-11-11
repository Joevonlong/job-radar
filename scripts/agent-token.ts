/**
 * Manage the agent tokens of MCP connections that are not the local stdio process (docs/mcp.md).
 *
 *   pnpm agent:token create --name NAME --permissions LIST [--expires YYYY-MM-DD]
 *   pnpm agent:token list
 *   pnpm agent:token revoke NAME_OR_PREFIX
 *
 * LIST is permission names (`jobs:read`, ...) and preset names (`read_only`, `assistant`, `all`), comma-separated or with
 * `--permissions` repeated. A token is valid through its `--expires` day in schedule.yaml `timezone`; without one it does not expire.
 * `create` prints the token alone on standard output, once; the database keeps only its hash. Everything else goes to standard
 * error. Exit code 0 = done, 1 = refused or failed, 2 = bad arguments. DATABASE_URL decides which database; `.env` is loaded by
 * the pnpm script.
 */
import { runAgentToken } from "../src/lib/agent-access/token-cli";
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { getTranslator } from "../src/lib/i18n/node";
import { errorCategory } from "../src/lib/mcp/context";

async function main(): Promise<number> {
  try {
    return await runAgentToken({
      db: getDb(),
      argv: process.argv.slice(2),
      now: () => new Date(),
      timezone: () => loadConfig("schedule").timezone,
      t: getTranslator("cli.agentToken", "cli"),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(getTranslator("cli.agentToken", "cli")("failed", { category: errorCategory(error) }));
    process.exit(1);
  },
);
