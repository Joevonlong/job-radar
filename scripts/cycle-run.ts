/**
 * Run one processing cycle by hand.
 *
 *   pnpm cycle:run [--kind manual|weekday_morning|weekday_evening|weekend|catchup]
 *                  [--channel <id>]... [--dry-run] [--backfill <N>h|<N>d]
 *
 * --backfill queues a manual request for the runner; it cannot be combined with --dry-run or a non-manual kind.
 * --dry-run collects and parses in memory only: no cycle, run, raw posting, usage or circuit writes. When the database
 * (DATABASE_URL, or the local compose default) is reachable and migrated it is opened read-only and the dry run starts
 * from the persisted month usage, circuit state and stored postings, admitting requests like a real run would. Its
 * requests are real (paid channels bill them) but its usage is not persisted. Otherwise it starts from empty state.
 * `--channel fixture` serves tests/fixtures/fixture-channel and needs --dry-run.
 * `.env` is loaded by the pnpm script (node --env-file-if-exists=.env --import tsx).
 * With ai.yaml `execution: host` (default) the `ai` and `notify` steps are only delegated (a `run_ai` request is
 * queued for the ai-worker; `pnpm ai-worker --once` handles it). `execution: container` runs them here.
 */
import { parseArgs } from "node:util";

import { createActivityRecorder, noopRecorder } from "../src/lib/activity";
import { registerBuiltinChannels } from "../src/lib/channels/builtin";
import { FIXTURE_CHANNEL_ID, registerFixtureChannel } from "../src/lib/channels/fixture";
import { defaultRegistry } from "../src/lib/channels/registry";
import { loadConfig } from "../src/lib/config";
import { parseBackfillArg, submitBackfill, validateBackfillCliArgs } from "../src/lib/control/backfill-arg";
import { requestRunCycle } from "../src/lib/control/service";
import { closeDb, getDb, type Db } from "../src/lib/db";
import { probeCycleState } from "../src/lib/db/health";
import { createReadOnlyDb, type ReadOnlyDb } from "../src/lib/db/read-only-client";
import { cycleKindEnum } from "../src/lib/db/schema";
import { registerBuiltinAiSubtasks, registerBuiltinCycleSteps } from "../src/lib/cycle/builtin-steps";
import type { CollectResult } from "../src/lib/cycle/collect";
import { runCycle } from "../src/lib/cycle/run-cycle";
import { createProcessLogger } from "../src/lib/logging/process-logger";
import { installShutdown } from "../src/lib/ops/shutdown";
import type { MaintenanceResult, PipelineResult } from "../src/lib/pipeline";

const KINDS = cycleKindEnum.enumValues;
type Kind = (typeof KINDS)[number];

function fail(message: string): never {
  console.error(`cycle:run: ${message}`);
  process.exit(2);
}

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

async function main(): Promise<number> {
  let values: { kind?: string; backfill?: string; channel?: string[]; "dry-run"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        kind: { type: "string" },
        backfill: { type: "string" },
        channel: { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "bad arguments");
  }
  if (values.help) {
    console.log("Usage: pnpm cycle:run [--kind <kind>] [--channel <id>]... [--dry-run] [--backfill <N>h|<N>d]\nKinds: " + KINDS.join(", ") + "\nBackfill: queue a manual run for the runner (integer hours or days, at most 720 h); no --dry-run or non-manual --kind.");
    return 0;
  }
  const kindArg = values.kind ?? "manual";
  if (!isKind(kindArg)) return fail(`unknown --kind "${kindArg}" (one of: ${KINDS.join(", ")})`);
  const dryRun = values["dry-run"] ?? false;
  const channelIds = values.channel ?? [];
  const backfillHours = values.backfill === undefined ? null : parseBackfillArg(values.backfill);
  if (values.backfill !== undefined) {
    if (backfillHours === null) return fail("--backfill requires integer hours or days in the range 1..720 h (for example 36h or 3d)");
    const error = validateBackfillCliArgs({ dryRun, kind: kindArg });
    if (error) return fail(error);
  }

  registerBuiltinChannels(defaultRegistry);
  registerBuiltinCycleSteps();
  registerBuiltinAiSubtasks();
  if (channelIds.includes(FIXTURE_CHANNEL_ID)) {
    if (!dryRun && process.env.NODE_ENV !== "test") return fail("the fixture channel only runs with --dry-run");
    registerFixtureChannel(defaultRegistry);
  }

  const channelsConfig = loadConfig("channels");
  for (const id of channelIds) {
    if (!defaultRegistry.has(id)) {
      const known = defaultRegistry.list().map((c) => c.id);
      return fail(`unknown channel "${id}" (registered: ${known.length > 0 ? known.join(", ") : "none"})`);
    }
    if (!defaultRegistry.isEnabled(id, channelsConfig)) return fail(`channel "${id}" is disabled in config/sources.yaml`);
  }

  if (backfillHours !== null) {
    try {
      return await submitBackfill({ hours: backfillHours, channelIds }, { request: requestRunCycle, out: console.log, err: console.error });
    } finally {
      await closeDb();
    }
  }

  let db: Db | null = null;
  let readOnly: ReadOnlyDb | null = null;
  if (!dryRun) {
    db = getDb();
  } else {
    readOnly = createReadOnlyDb();
    const state = await probeCycleState(readOnly.db);
    if (state === "ok") {
      db = readOnly.db;
      console.log("[dry-run] budget, circuit state and stored postings are read from the database (read-only); nothing is written");
    } else if (state === "not_migrated") {
      console.warn("cycle:run: database reachable but not migrated (or behind the code); dry run starts from empty budget and circuit state and knows no stored postings, so paid channels are not held to their monthly caps");
    } else if (state === "unreadable") {
      console.warn("cycle:run: database reachable but its budget and circuit state could not be read; dry run starts from empty budget and circuit state and knows no stored postings, so paid channels are not held to their monthly caps");
    } else {
      console.warn("cycle:run: database unreachable; dry run starts from empty budget and circuit state and knows no stored postings, so paid channels are not held to their monthly caps");
    }
  }

  const activity = dryRun ? noopRecorder : createActivityRecorder({ db: db ?? getDb(), process: "cli" });
  const logger = createProcessLogger();
  const abort = new AbortController();
  const shutdown = installShutdown({
    abort,
    log: (message) => logger.info(message),
    graceMs: () => loadConfig("ai").host_worker.shutdown_grace_seconds * 1000,
    exit: (code) => process.exit(code),
  });
  try {
    const result = await runCycle(kindArg, { activity, dryRun, db, logger, signal: abort.signal, ...(channelIds.length > 0 ? { channelIds } : {}) });
    const collect = result.results.collect as CollectResult | undefined;
    const prefix = dryRun ? "[dry-run] " : "";
    console.log(`${prefix}cycle ${result.kind}${result.cycleId === null ? "" : ` #${result.cycleId}`}: ${result.status} in ${result.summary.durationMs} ms`);
    for (const step of result.summary.steps) {
      console.log(`  step ${step.name}: ${step.status}${step.reason ? ` (${step.reason})` : ""}${step.error ? ` - ${step.error}` : ""}`);
    }
    const pipeline = result.results.pipeline as PipelineResult | undefined;
    if (pipeline) {
      const merged = pipeline.merged.same_source + pipeline.merged.exact_key + pipeline.merged.simhash;
      console.log(`  pipeline: processed=${pipeline.processed} created=${pipeline.created} merged=${merged} updated=${pipeline.updated} parse_failed=${pipeline.parseFailed} deferred=${pipeline.deferred}`);
      for (const f of pipeline.failures) console.log(`    raw #${f.rawPostingId} (${f.channelId}): ${f.reason}`);
    }
    const maintenance = result.results.maintenance as MaintenanceResult | undefined;
    if (maintenance) {
      console.log(`  maintenance: seen=${maintenance.seen} reopened=${maintenance.reopened} possibly_closed=${maintenance.possiblyClosed} link_checked=${maintenance.linkChecked} closed=${maintenance.closed}`);
    }
    if (collect) {
      console.log(`  queries: ${collect.queries}`);
      if (!channelsConfig.collect.query_rotation) {
        console.log("  query order: config order (collect.query_rotation is false)");
      } else if (dryRun) {
        console.log("  query order: config order (dry runs do not read run history; real runs rotate by history)");
      } else if (Object.values(collect.rotation).some((unit) => unit.historyUnavailable)) {
        console.log("  query order: config order (run history could not be read)");
      }
      for (const q of collect.queryPlan ?? []) {
        const where = q.remoteScope === null ? `location=${q.location ?? "-"}` : `remoteScope=${q.remoteScope}`;
        console.log(`    ${q.id} keywordGroup=${q.keywordGroup} ${where} windowHours=${q.windowHours} maxResults=${q.maxResults}`);
      }
      for (const [id, s] of Object.entries(collect.channels)) {
        const codes = Object.keys(s.errorCodes).length > 0 ? ` errors=${JSON.stringify(s.errorCodes)}` : "";
        console.log(`  ${id}: runs=${s.runs} ok=${s.succeeded} failed=${s.failed} skipped=${s.skipped} interrupted=${s.interrupted} fetched=${s.fetched} new=${s.inserted} cost=$${s.costUsd}${codes}`);
        const report = collect.dryRun?.[id];
        if (report) {
          console.log(`    parsed ${report.parsed}/${report.fetched} (${report.parseFailed} failed to parse)`);
          for (const title of report.sampleTitles) console.log(`    - ${title}`);
        }
      }
      for (const [id, code] of Object.entries(collect.unusable)) console.log(`  gave up on ${id} this cycle: ${code}`);
      for (const error of collect.errors) console.log(`  collect error: ${error}`);
    }
    return result.status === "failed" ? 1 : result.status === "skipped" ? 3 : 0;
  } finally {
    try {
      await activity.close();
      await readOnly?.close();
      await closeDb();
    } finally {
      shutdown.dispose();
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`cycle:run: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
