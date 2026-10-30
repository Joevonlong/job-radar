import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/lib/config/load";
import { closeDb, getDb } from "../src/lib/db/client";
import { checkCurrentScores, currentScoresTableExists, rebuildCurrentScores } from "../src/lib/db/repos/current-scores";
import { translatorFor } from "../src/lib/i18n/node";
import { scopeLocale } from "../src/lib/i18n/node";

const { values } = parseArgs({ options: { rebuild: { type: "boolean" }, batch: { type: "string" } }, strict: true });
const batchJobs = z.coerce.number().int().min(1).max(100000).parse(values.batch ?? loadConfig("currentScores").refresh.lateral_max_jobs);
const t = translatorFor(scopeLocale("cli"), "currentScores");
try {
  const db = getDb();
  if (!(await currentScoresTableExists(db))) { console.error(t("missing")); process.exitCode = 1; }
  else {
    if (values.rebuild) console.log(t("rebuilt", { count: await rebuildCurrentScores(db, { batchJobs }) }));
    const ids = await checkCurrentScores(db);
    console.log(t("checked", { count: ids.length }));
    if (ids.length > 0) process.exitCode = 1;
  }
} finally { await closeDb(); }
