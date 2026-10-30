import { parseArgs } from "node:util";

/** Apply migrations to the configured URL without resolving a Compose backup container. */
import { currentScoresBackfill } from "../src/lib/db/current-scores-config";
import { runMigrations } from "../src/lib/db/migrate";
import { scopeLocale, translatorFor } from "../src/lib/i18n/node";

parseArgs({ options: {}, strict: true, allowPositionals: false });
const t = translatorFor(scopeLocale("cli"), "currentScores");
await runMigrations({ currentScoresBackfill: currentScoresBackfill() });
console.log(t("migrated"));
