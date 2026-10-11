/**
 * pnpm run doctor [--json] [--only <id-prefix>]... [--lang <locale>]   (`pnpm doctor` alone is pnpm's own command)
 *
 * Checks the whole system from the host (Docker and the compose services, the database and its migrations, the runner and
 * ai-worker heartbeats, the claude / codex logins, Telegram, Tailscale, backups, channels and budgets, the schedule, free disk)
 * and prints ✅ / ⚠️ / ❌ with a fix hint for each. Read-only: it sends no message, spends no money and changes nothing.
 *
 * Exit code: 0 = all good, 1 = warnings, 2 = failures, 3 = doctor itself could not run (bad arguments / unreadable config).
 * `--lang en|zh` picks the report's language (default: language.yaml cli.locale, else the interface default).
 * `--json` prints the report as JSON for scripts: ids and statuses are codes, `locale` says the language of the texts. `--only <prefix>` keeps the results whose id starts with the prefix (`compose`, `compose.db`, `tailscale`).
 * Run it in the project directory (the pnpm script loads .env); point it at another environment with the usual DATABASE_URL,
 * JOB_RADAR_CONFIG_DIR, RUNNER_BACKUP_DIR, JOBSPY_URL and JOB_RADAR_DOCTOR_WEB_URL.
 */
import { parseArgs } from "node:util";

import { isLocale, LOCALES } from "../src/i18n/locale";
import { loadConfig } from "../src/lib/config";
import { closeDb } from "../src/lib/db";
import { redact } from "../src/lib/ops/doctor/helpers";
import { createRealContext } from "../src/lib/ops/doctor/probes";
import { ALL_CHECKS, renderJson, renderText, runDoctor, selectChecks } from "../src/lib/ops/doctor";

const CLOSE_TIMEOUT_MS = 3000;

async function main(): Promise<number> {
  let values: { json?: boolean; only?: string[]; lang?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ options: { json: { type: "boolean" }, only: { type: "string", multiple: true }, lang: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true }));
  } catch (error) {
    console.error(`doctor: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 3;
  }
  if (values.help) {
    console.log(`Usage: pnpm run doctor [--json] [--only <id prefix>]... [--lang ${LOCALES.join("|")}]\nExit code: 0 all good, 1 warnings, 2 failures, 3 doctor could not run.`);
    return 0;
  }
  if (values.lang !== undefined && !isLocale(values.lang)) {
    console.error(`doctor: --lang must be one of ${LOCALES.join(", ")}`);
    return 3;
  }
  const prefixes = values.only ?? [];
  if (selectChecks(prefixes).length === 0) {
    console.error(`doctor: no check matches ${prefixes.join(", ")}. Groups of ids: ${[...new Set(ALL_CHECKS.map((c) => c.id.split(".")[0]))].join(", ")}`);
    return 3;
  }
  try {
    const ctx = await createRealContext(process.env, values.lang === undefined ? {} : { lang: values.lang });
    const report = await runDoctor(ctx, ALL_CHECKS, { only: prefixes });
    console.log(values.json ? renderJson(report) : renderText(report, { timeZone: loadConfig("schedule").timezone, t: ctx.t }));
    return report.exitCode;
  } catch (error) {
    console.error(`doctor: ${redact(error instanceof Error ? error.message : String(error))}`);
    return 3;
  }
}

main().then(
  async (code) => {
    await Promise.race([closeDb(), new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
    process.exit(code);
  },
  (error: unknown) => {
    console.error(`doctor: ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exit(3);
  },
);
