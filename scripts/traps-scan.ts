/**
 * Scan jobs for AI traps (docs/ai-traps.md).
 *
 *   pnpm traps:scan [--write] [--job ID] [--all] [--limit N] [--json] [--mark-stale] [--html FILE]
 *
 * Previews by default (nothing is written); `--write` stores the findings. Jobs whose JD, source payloads and rules did not
 * change since their last scan are skipped, so a second `--write` run reports 0 changes. `--html FILE` runs the rule layer on a
 * local HTML file and needs no database. File reading and printing live here; the logic is `src/lib/traps`.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { z } from "zod";

import { htmlToText } from "../src/lib/channels/ats/text";
import { registerBuiltinChannels } from "../src/lib/channels/builtin";
import { ChannelRegistry } from "../src/lib/channels/registry";
import { loadConfig } from "../src/lib/config";
import type { TrapsConfig } from "../src/lib/config/schemas/traps";
import { closeDb, getDb } from "../src/lib/db";
import { countTrappedScores, listAllJobIds, markTrappedScoresStale } from "../src/lib/db/repos/traps";
import { runTrapScan, scanJob, type TrapFinding, type TrapScanResult } from "../src/lib/traps";
import { scopeLocale } from "../src/lib/i18n/node";
import { trapsTranslator } from "../src/lib/traps/text";

const t = trapsTranslator(scopeLocale("cli"));
/** Jobs per `--all` round. */
const ALL_CHUNK = 500;
/** Jobs of an ordinary run when `--limit` is not given. */
const DEFAULT_LIMIT = 100_000;

const argsSchema = z.object({
  write: z.boolean(),
  job: z.coerce.number().int().positive().optional(),
  all: z.boolean(),
  limit: z.coerce.number().int().positive().optional(),
  json: z.boolean(),
  markStale: z.boolean(),
  html: z.string().min(1).optional(),
  help: z.boolean(),
});
type Args = z.infer<typeof argsSchema>;

function readArgs(): Args {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      job: { type: "string" },
      all: { type: "boolean", default: false },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      "mark-stale": { type: "boolean", default: false },
      html: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return argsSchema.parse({ ...values, markStale: values["mark-stale"] });
}

function severityLabel(severity: string): string {
  return severity === "trap" || severity === "suspicious" ? t(`panel.severity.${severity}`) : severity;
}

function findingLine(f: TrapFinding): string {
  const technique = (["hidden_text", "invisible_unicode", "html_comment", "attribute_text", "non_rendered", "instruction", "other"] as const).find((x) => x === f.technique);
  const how = [technique ? t(`panel.technique.${technique}`) : f.technique, f.method].filter((p): p is string => p !== null).join(" · ");
  const location = f.quoteOffset !== null ? t("cli.inDescription", { offset: f.quoteOffset }) : f.location;
  const decoded = typeof f.detail.decoded === "string" ? f.detail.decoded : null;
  const quote = (decoded ?? f.quote).replace(/\s+/g, " ").slice(0, 160);
  return t("cli.finding", { severity: severityLabel(f.severity), how, location, quote });
}

function scanHtmlFile(file: string, settings: TrapsConfig, json: boolean): void {
  const html = readFileSync(file, "utf8");
  // what a converter would have made of the page (hidden text included), so the findings are placed as they would be for a job
  const description = htmlToText(html);
  const { findings, trigger } = scanJob({ description, sources: [{ rawPostingId: 0, fragments: [{ path: "file", html }] }] }, settings);
  if (json) {
    console.log(JSON.stringify({ file, findings, trigger }, null, 2));
    return;
  }
  console.log(t("cli.html", { file, count: findings.length }));
  for (const finding of findings) console.log(findingLine(finding));
}

function addUp(total: TrapScanResult, part: TrapScanResult): void {
  for (const key of ["scanned", "changed", "withTraps", "withSuspicious", "signalRescans", "failed"] as const) total[key] += part[key];
  total.aborted ||= part.aborted;
  total.jobs.push(...part.jobs);
  if (part.skipped) total.skipped = part.skipped;
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
  const settings = loadConfig("traps");
  if (args.html) {
    scanHtmlFile(args.html, settings, args.json);
    return;
  }
  if (!settings.enabled) {
    console.log(t("cli.disabled"));
    return;
  }
  if (args.markStale && !args.write) console.error(t("cli.staleNeedsWrite"));

  const db = getDb();
  const registry = new ChannelRegistry();
  registerBuiltinChannels(registry);
  const logger = { info: () => {}, warn: () => {}, error: (message: string, meta?: Record<string, unknown>) => console.error(message, meta ?? "") };
  const base = { settings, channels: registry, logger, write: args.write, collect: args.json || args.job !== undefined };

  const result: TrapScanResult = { scanned: 0, changed: 0, withTraps: 0, withSuspicious: 0, signalRescans: 0, failed: 0, aborted: false, jobs: [] };
  if (args.job !== undefined) {
    addUp(result, await runTrapScan(db, { ...base, limit: 1, jobIds: [args.job], force: true }));
  } else if (args.all) {
    let afterId = 0;
    let left = args.limit ?? Number.MAX_SAFE_INTEGER;
    while (left > 0) {
      const ids = await listAllJobIds(db, { afterId, limit: Math.min(ALL_CHUNK, left) });
      if (ids.length === 0) break;
      afterId = ids[ids.length - 1] as number;
      left -= ids.length;
      addUp(result, await runTrapScan(db, { ...base, limit: ids.length, jobIds: ids, force: true }));
    }
  } else {
    addUp(result, await runTrapScan(db, { ...base, limit: args.limit ?? DEFAULT_LIMIT }));
  }
  if (result.skipped === "no_tables") {
    console.error(t("cli.noTables"));
    process.exitCode = 1;
    return;
  }

  let staleCount = await countTrappedScores(db);
  let markedJobs: number[] = [];
  if (args.markStale && args.write) {
    markedJobs = await markTrappedScoresStale(db);
    staleCount = 0;
  }

  if (args.json) {
    console.log(JSON.stringify({ write: args.write, ...result, staleScores: staleCount, markedStaleJobs: markedJobs }, null, 2));
    return;
  }
  if (!args.write) console.log(t("cli.preview"));
  console.log(t("cli.summary", { scanned: result.scanned, changed: result.changed, withTraps: result.withTraps, withSuspicious: result.withSuspicious, failed: result.failed }));
  if (result.signalRescans > 0) console.log(t("cli.rescans", { count: result.signalRescans }));
  for (const job of result.jobs) {
    console.log(`${t("cli.job", { id: job.jobId, traps: job.traps, suspicious: job.suspicious })}${job.changed ? t("cli.changed") : ""}`);
    for (const finding of job.findings ?? []) console.log(findingLine(finding));
  }
  if (markedJobs.length > 0) console.log(t("cli.staleDone", { count: markedJobs.length }));
  else if (staleCount > 0) console.log(`${t("cli.staleCount", { count: staleCount })} · ${t("cli.staleHint")}`);
}

main()
  .catch((error: unknown) => {
    console.error(t("cli.failed", { message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
