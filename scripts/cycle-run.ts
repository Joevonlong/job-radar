/**
 * Run one processing cycle by hand.
 *
 *   pnpm cycle:run [--kind manual|weekday_morning|weekday_evening|weekend|catchup]
 *                  [--channel <id>]... [--dry-run]
 *
 * --dry-run collects and parses in memory only: no cycle, run, raw posting, usage or circuit writes.
 * It reads the database (when DATABASE_URL points at a reachable one) so budgets and circuit state
 * are honoured. `--channel fixture` serves tests/fixtures/fixture-channel and needs --dry-run.
 * `.env` is loaded by the pnpm script (node --env-file-if-exists=.env --import tsx).
 * With ai.yaml `execution: host` (default) the `ai` and `notify` steps are only delegated (a `run_ai` request is
 * queued for the ai-worker; `pnpm ai-worker --once` handles it). `execution: container` runs them here.
 */
import { parseArgs } from "node:util";

import { registerBuiltinChannels } from "../src/lib/channels/builtin";
import { FIXTURE_CHANNEL_ID, registerFixtureChannel } from "../src/lib/channels/fixture";
import { defaultRegistry } from "../src/lib/channels/registry";
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb, pingDb, type Db } from "../src/lib/db";
import { cycleKindEnum } from "../src/lib/db/schema";
import { registerBuiltinAiSubtasks, registerBuiltinCycleSteps } from "../src/lib/cycle/builtin-steps";
import type { CollectResult } from "../src/lib/cycle/collect";
import { runCycle } from "../src/lib/cycle/run-cycle";
import { createProcessLogger } from "../src/lib/logging/process-logger";
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
  let values: { kind?: string; channel?: string[]; "dry-run"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        kind: { type: "string" },
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
    console.log("Usage: pnpm cycle:run [--kind <kind>] [--channel <id>]... [--dry-run]\nKinds: " + KINDS.join(", "));
    return 0;
  }
  const kindArg = values.kind ?? "manual";
  if (!isKind(kindArg)) return fail(`unknown --kind "${kindArg}" (one of: ${KINDS.join(", ")})`);
  const dryRun = values["dry-run"] ?? false;
  const channelIds = values.channel ?? [];

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

  let db: Db | null = null;
  if (!dryRun) {
    db = getDb();
  } else {
    const candidate = getDb();
    if (await pingDb(candidate)) db = candidate;
    else console.warn("cycle:run: database unreachable; dry run starts from empty budget and circuit state");
  }

  const logger = createProcessLogger();
  try {
    const result = await runCycle(kindArg, { dryRun, db, logger, ...(channelIds.length > 0 ? { channelIds } : {}) });
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
      if (Object.values(collect.rotation).some((unit) => unit.historyUnavailable)) {
        if (dryRun) console.log("  query order: config order (dry runs do not read run history; real runs rotate by history)");
        else console.log("  query order: config order (run history unavailable for the starting channel)");
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
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`cycle:run: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
