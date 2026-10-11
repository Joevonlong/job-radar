/**
 * Run the ghost job check (docs/ghost-jobs.md).
 *
 *   pnpm ghost:check [--write] [--job ID] [--limit N] [--json]
 *
 * Previews by default (nothing is written), also while ui.yaml `job_checks.ghost.enabled` is false: that is how the owner sees the
 * share of each level before turning the check on. `--write` stores the results and is refused while the check is off. Jobs whose
 * inputs did not change since their last check (and did not reach the next "open for long" tier) are skipped, so a second `--write`
 * run reports 0 changes. `--job ID` checks that job again even when its result is current. Reading and printing live here; the logic
 * is `src/lib/ghost`.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import { closeDb, getDb } from "../src/lib/db";
import { countGhostStats } from "../src/lib/db/repos/ghost";
import { ghostChannelsOf, ghostCheckConfig, runGhostCheck } from "../src/lib/ghost/step";
import { readGhostSettings } from "../src/lib/ghost/settings";
import { ghostTranslator } from "../src/lib/ghost/text";
import type { GhostLevel, GhostResult } from "../src/lib/ghost/types";
import { ghostReasonMessage } from "../src/lib/ghost/view";
import { scopeLocale } from "../src/lib/i18n/node";

const t = ghostTranslator(scopeLocale("cli"));

const argsSchema = z.object({
  write: z.boolean(),
  job: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  json: z.boolean(),
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
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return argsSchema.parse(values);
}

function share(count: number, total: number): string {
  return total === 0 ? "0%" : `${((count / total) * 100).toFixed(1)}%`;
}

function levelCounts(results: readonly GhostResult[]): Record<GhostLevel, number> {
  const counts: Record<GhostLevel, number> = { none: 0, watch: 0, likely: 0 };
  for (const result of results) counts[result.level] += 1;
  return counts;
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
  if (args.write && !readGhostSettings().enabled) {
    console.error(t("cli.disabled"));
    process.exitCode = 1;
    return;
  }

  const config = ghostCheckConfig();
  const db = getDb();
  const logger = { warn: () => {}, error: (message: string, meta?: Record<string, unknown>) => console.error(message, meta ?? "") };
  const result = await runGhostCheck(db, {
    ...config,
    channels: ghostChannelsOf(undefined),
    limit: args.job !== undefined ? 1 : (args.limit ?? config.limit),
    logger,
    now: new Date(),
    write: args.write,
    ...(args.job !== undefined ? { jobIds: [args.job], force: true } : {}),
  });
  if (result.skipped === "no_table") {
    console.error(t("cli.noTable"));
    process.exitCode = 1;
    return;
  }
  const stats = await countGhostStats(db);
  const counts = levelCounts(result.outcomes.map((o) => o.result));
  const checked = result.outcomes.length;
  if (args.json) {
    const jobs = result.outcomes.map((o) => ({ jobId: o.jobId, changed: o.changed, level: o.result.level, score: o.result.score, reasons: o.result.reasons }));
    const levels = { ...counts, share: { none: share(counts.none, checked), watch: share(counts.watch, checked), likely: share(counts.likely, checked) } };
    console.log(JSON.stringify({ write: args.write, enabled: readGhostSettings().enabled, scanned: result.scanned, changed: result.changed, failed: result.failed, aborted: result.aborted, levels, jobs, stats }, null, 2));
    return;
  }
  if (!args.write) console.log(t("cli.preview"));
  console.log(t("cli.summary", { scanned: result.scanned, changed: result.changed, failed: result.failed }));
  console.log(t("cli.levels", { likely: counts.likely, likelyShare: share(counts.likely, checked), watch: counts.watch, watchShare: share(counts.watch, checked), none: counts.none }));
  // every job of a single-job run; otherwise only those whose result changed and that carry a mark
  for (const outcome of result.outcomes) {
    if (args.job === undefined && (!outcome.changed || outcome.result.level === "none")) continue;
    console.log(`${t("cli.job", { id: outcome.jobId, level: t(`cli.level.${outcome.result.level}`), score: outcome.result.score })}${outcome.changed ? t("cli.changed") : ""}`);
    for (const reason of outcome.result.reasons) {
      const message = ghostReasonMessage(reason);
      console.log(t("cli.reason", { reason: t(message.key, message.values), points: reason.points }));
    }
  }
  if (stats) {
    console.log(t("cli.stats", { likely: stats.byLevel.likely, watch: stats.byLevel.watch, none: stats.byLevel.none, dismissed: stats.dismissed, unchecked: stats.unchecked }));
  }
}

main()
  .catch((error: unknown) => {
    console.error(t("cli.failed", { message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
