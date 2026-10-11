/**
 * Check what the JDs say about visa sponsorship (docs/visa-sponsorship.md).
 *
 *   pnpm visa:scan [--write] [--job ID] [--limit N] [--json] [--text FILE]
 *
 * Previews by default (nothing is written); `--write` stores the results. Jobs whose JD, company, hidden JD pieces and rules did
 * not change since their last check are skipped, so a second `--write` run reports 0 changes. `--job ID` checks that job again
 * even when its result is current. `--text FILE` runs the rules on a local text file and needs no database. File reading and
 * printing live here; the logic is `src/lib/visa`.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { z } from "zod";

import { closeDb, getDb } from "../src/lib/db";
import { countVisaStats } from "../src/lib/db/repos/visa";
import { scopeLocale } from "../src/lib/i18n/node";
import { loadPipeline } from "../src/lib/market";
import { detectVisa } from "../src/lib/visa/detect";
import { visaRulesFingerprint } from "../src/lib/visa/fingerprint";
import { visaRulesFor } from "../src/lib/visa/rules";
import { readVisaSettings } from "../src/lib/visa/settings";
import { runVisaScan } from "../src/lib/visa/step";
import { visaTranslator } from "../src/lib/visa/text";
import type { VisaEvidence, VisaResult } from "../src/lib/visa/types";

const t = visaTranslator(scopeLocale("cli"));

const argsSchema = z.object({
  write: z.boolean(),
  job: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  json: z.boolean(),
  text: z.string().min(1).optional(),
  help: z.boolean(),
});
type Args = z.infer<typeof argsSchema>;

function readArgs(): Args {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      job: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      text: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return argsSchema.parse(values);
}

function statusText(result: VisaResult): string {
  const kind = result.evidence.find((e) => e.status === "not_offered")?.kind;
  return result.status === "not_offered" && kind === "permit_required" ? t("checks.permit_required") : t(`status.${result.status}`);
}

function quoteLine(e: VisaEvidence): string {
  return t("cli.quote", { status: t(`checks.quoteStatus.${e.status}`), offset: e.offset, quote: e.quote.replace(/\s+/g, " ") });
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = readArgs();
  } catch {
    console.error(t("cli.usage"));
    process.exit(2);
  }
  if (args.help) {
    console.log(t("cli.usage"));
    return;
  }
  const pipeline = loadPipeline();
  const rules = visaRulesFor(pipeline);
  if (args.text) {
    const result = detectVisa(readFileSync(args.text, "utf8"), rules);
    if (args.json) {
      console.log(JSON.stringify({ file: args.text, ...result }, null, 2));
      return;
    }
    console.log(t("cli.text", { file: args.text, status: statusText(result) }));
    for (const e of result.evidence) console.log(quoteLine(e));
    return;
  }
  if (!readVisaSettings().enabled) {
    console.log(t("cli.disabled"));
    return;
  }

  const db = getDb();
  const logger = { info: () => {}, warn: () => {}, error: (message: string, meta?: Record<string, unknown>) => console.error(message, meta ?? "") };
  const result = await runVisaScan(db, {
    rules,
    rulesHash: visaRulesFingerprint(pipeline),
    limit: args.job !== undefined ? 1 : (args.limit ?? pipeline.job_checks.visa.per_cycle_limit),
    logger,
    write: args.write,
    ...(args.job !== undefined ? { jobIds: [args.job], force: true } : {}),
  });
  if (result.skipped === "no_table") {
    console.error(t("cli.noTable"));
    process.exitCode = 1;
    return;
  }
  const stats = await countVisaStats(db);
  if (args.json) {
    const jobs = result.outcomes.map((o) => ({ jobId: o.jobId, changed: o.changed, ...o.result }));
    console.log(JSON.stringify({ write: args.write, scanned: result.scanned, changed: result.changed, failed: result.failed, aborted: result.aborted, jobs, stats }, null, 2));
    return;
  }
  if (!args.write) console.log(t("cli.preview"));
  console.log(t("cli.summary", { scanned: result.scanned, changed: result.changed, failed: result.failed }));
  // every job of a single-job run; otherwise only those whose result changed
  for (const outcome of result.outcomes) {
    if (args.job === undefined && !outcome.changed) continue;
    console.log(`${t("cli.job", { id: outcome.jobId, status: statusText(outcome.result) })}${outcome.changed ? t("cli.changed") : ""}`);
    for (const e of outcome.result.evidence) console.log(quoteLine(e));
  }
  if (stats) {
    console.log(
      t("cli.stats", {
        offered: stats.byStatus.offered,
        notOffered: stats.byStatus.not_offered,
        noSponsorship: stats.notOfferedByKind.no_sponsorship,
        permitRequired: stats.notOfferedByKind.permit_required,
        unclear: stats.byStatus.unclear,
        notMentioned: stats.byStatus.not_mentioned,
        unchecked: stats.unchecked,
      }),
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(t("cli.failed", { message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
