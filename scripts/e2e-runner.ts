/**
 * A stand-in for the runner process, started by e2e/global-setup.ts for the Playwright run.
 *
 *   DATABASE_URL=<e2e database> JOB_RADAR_CONFIG_DIR=<e2e config copy> tsx scripts/e2e-runner.ts
 *
 * The real runner (src/runner/index.ts) also schedules cycles and talks to the outside world, which
 * a UI test must not. This script runs the parts the settings page depends on, with the same library
 * code: the heartbeat, the "config loaded" acknowledgement (watchConfig + recordConfigLoaded) and the
 * control-request poller. Its `run_cycle` handler is a stub that takes a moment and reports success
 * without creating a cycle row, so a test run does not change what the dashboard e2e sees as "the
 * latest cycle". A backfill ends by itself too (see BACKFILL_GATE_LOCK). The real handler is covered by tests/integration/control.test.ts.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";

import { createLogger } from "../src/lib/channels/logger";
import { loadConfig, readConfigText, watchConfig } from "../src/lib/config";
import { syncSourceRegistry } from "../src/lib/sources/registry/sync";
import { registerControlHandler, runControlPoller } from "../src/lib/control";
import { closeDb, getDb, writeHeartbeat } from "../src/lib/db";
import { getJobForBreakdown, upsertJobBreakdown } from "../src/lib/db/repos/breakdowns";
import { BREAKDOWN_PROMPT_VERSION } from "../src/lib/ai/prompts/breakdown";
import { runCyclePayloadSchema, breakdownJobPayloadSchema } from "../src/lib/control/types";
import { descriptionHash } from "../src/lib/translation/hash";
import { runMigrations } from "../src/lib/db/migrate";
import { recordAllConfigLoaded, recordConfigLoaded } from "../src/lib/settings/ack";
import { SALARY_PROMPT_VERSION } from "../src/lib/ai/prompts/salary";
import { salaryLookupPayloadSchema } from "../src/lib/control/types";
import { getJobForSalaryLookup, insertSalaryLookup } from "../src/lib/db/repos/salary-lookups";
import { compileFamilies } from "../src/lib/salary/families";
import { salaryLookupKey } from "../src/lib/salary/lookup";
import { loadBaseCurrency } from "../src/lib/signals/floor";
import { ACK_NAMES, isAckName } from "../src/lib/settings/tabs";

/** How long the stub cycle "runs": long enough for a test to see the running state. */
const STUB_CYCLE_MS = 1500;
const HEARTBEAT_MS = 1000;
const POLL_SECONDS = 1;
/** How long a stub test "runs": long enough for a test to see the pending / running state. */
const STUB_TEST_MS = 800;
/**
 * A stub backfill runs STUB_CYCLE_MS, then waits for this advisory lock (shared) before it ends as done: e2e/sources.spec.ts
 * holds it while it checks that a second backfill is refused. The wait ends after BACKFILL_GATE_TIMEOUT whatever happens,
 * so a test that died holding it cannot keep the stand-in's queue busy.
 */
const BACKFILL_GATE_LOCK = 121;
const BACKFILL_GATE_TIMEOUT = "30s";

// the parent may be gone when the last lines are written: that is not an error
process.stdout.on("error", () => {});
const log = (message: string) => console.log(`e2e-runner: ${message}`);

await runMigrations();
const db = getDb();
const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => abort.abort());

registerControlHandler("run_cycle", async (request) => {
  const payload = runCyclePayloadSchema.safeParse(request.payload);
  if (payload.success && payload.data.backfillHours !== undefined) {
    // No collector runs here: the stub only takes its time, then ends like a cycle that collected nothing.
    await sleep(STUB_CYCLE_MS);
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${BACKFILL_GATE_TIMEOUT}'`));
        await tx.execute(sql`select pg_advisory_xact_lock_shared(${BACKFILL_GATE_LOCK})`);
      })
      .catch(() => {});
    return { status: "done", result: { cycleId: null, cycleStatus: "succeeded", durationMs: STUB_CYCLE_MS, backfillHours: payload.data.backfillHours } };
  }
  await sleep(STUB_CYCLE_MS);
  return { status: "done", result: { cycleId: null, cycleStatus: "succeeded", durationMs: STUB_CYCLE_MS } };
});

// The weekly interest suggestions call the AI and belong to the host ai-worker (which e2e does not run):
// the stand-in claims `run_suggest` itself and only answers, like the cycle stub above, so the page can be tested without any AI.
registerControlHandler("run_suggest", async () => ({ status: "done", result: { status: "skipped", skipped: "too_few_liked_jobs", stored: 0 } }));

// The test buttons. Real tests reach the sources, the AI CLIs and Telegram; the stand-in only answers like them.
registerControlHandler("test_channel", async (request) => {
  await sleep(STUB_TEST_MS);
  const channelId = typeof request.payload === "object" && request.payload !== null && "channelId" in request.payload ? String(request.payload.channelId) : "?";
  return { status: "done", result: { channelId, fetched: 3, parsed: 3, parseFailed: 0, sampleTitles: ["AI Engineer (e2e)", "Forward Deployed Engineer (e2e)"], durationMs: STUB_TEST_MS } };
});
registerControlHandler("test_telegram", async () => ({ status: "done", result: { messageId: 4242, bot: "e2e_bot" } }));
registerControlHandler("test_ai", async () => ({ status: "done", result: { provider: "codex-cli", model: "e2e-model", latencyMs: 1200, tokensIn: 20, tokensOut: 5 } }));

// The breakdown belongs to the host ai-worker (not run in e2e): answer like it, with a one-item breakdown quoting the JD's first line.
registerControlHandler("breakdown_job", async (request) => {
  await sleep(STUB_TEST_MS);
  const payload = breakdownJobPayloadSchema.safeParse(request.payload);
  if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
  const job = await getJobForBreakdown(db, payload.data.jobId);
  const quote = job?.description?.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? null;
  if (!job || job.description === null || quote === null) return { status: "failed", result: { jobId: payload.data.jobId, error: "no_description" } };
  const offset = job.description.indexOf(quote);
  await upsertJobBreakdown(db, {
    jobId: job.id,
    sourceHash: descriptionHash(job.description),
    promptVersion: BREAKDOWN_PROMPT_VERSION,
    outputLang: "zh",
    provider: "e2e",
    model: "e2e-model",
    content: {
      responsibilities: [{ text: "（e2e）阅读并拆解 JD", quote, offset }],
      tech_stack: [{ name: "Python", category: "languages", requirement: "must", quote, offset }],
      experience: { years_min: null, years_quote: null, items: [] },
      projects: [],
      soft_skills: [],
      languages: [],
      other: [],
    },
    droppedItems: 0,
  });
  return { status: "done", result: { jobId: job.id, cached: false, provider: "e2e", model: "e2e-model", items: 2, dropped: 0 } };
});

// The salary lookup belongs to the host ai-worker too (it searches the web): answer like it, with a one-band result.
registerControlHandler("salary_lookup", async (request) => {
  await sleep(STUB_TEST_MS);
  const payload = salaryLookupPayloadSchema.safeParse(request.payload);
  if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
  const job = await getJobForSalaryLookup(db, payload.data.jobId);
  if (!job) return { status: "failed", result: { jobId: payload.data.jobId, error: "not_found" } };
  const salary = loadConfig("salary");
  const currency = loadBaseCurrency() ?? "EUR";
  const fetchedAt = new Date();
  const source = { url: "https://www.levels.fyi/companies/e2e/salaries", host: "www.levels.fyi", site: "Levels.fyi", title: "e2e salaries", excerpt: "e2e: 90k to 110k", trusted: true };
  const band = { title: job.title, seniority: null, min: 90000, max: 110000, median: 100000, original: { min: 90000, max: 110000, median: 100000, currency }, convertible: true, basis: "base" as const, location: job.location?.city ?? null, sources: [0] };
  const id = await insertSalaryLookup(db, {
    companyId: job.companyId,
    jobId: job.id,
    lookupKey: salaryLookupKey(job, compileFamilies(salary.role_families).familyOf(job.title)),
    status: "done",
    result: {
      query: { company: job.company, title: job.title, city: job.location?.city ?? null, country: job.location?.countryCode ?? null, seniority: job.seniority, currency },
      companyLevel: { level: "market", median: 100000, summary: "e2e summary", sources: [0] },
      roleBand: band,
      relatedRoles: [],
      sources: [source],
      confidence: "high",
      notes: "",
      dropped: 0,
      observations: [],
    },
    confidence: "high",
    provider: "e2e",
    model: "e2e-model",
    promptVersion: SALARY_PROMPT_VERSION,
    errorCode: null,
    fetchedAt,
    expiresAt: new Date(fetchedAt.getTime() + salary.lookup.ttl_days * 86_400_000),
  });
  return { status: "done", result: { jobId: job.id, lookupId: id, cached: false, provider: "e2e", model: "e2e-model" } };
});

await recordAllConfigLoaded(db);
await syncSourceRegistry(db, { config: loadConfig("channels"), text: readConfigText("channels") }).catch(() => {});
const stopWatching = watchConfig(
  [...ACK_NAMES],
  (event) => {
    log(`config ${event.name} reloaded`);
    if (isAckName(event.name)) void recordConfigLoaded(db, event.name, event.text);
    // A hand-edited sources.yaml reaches the registry mirror here, like in the real runner
    if (event.name === "channels") void syncSourceRegistry(db, { config: loadConfig("channels"), text: readConfigText("channels") }).catch(() => {});
  },
  { pollMs: 300, debounceMs: 50 },
);

// What the settings, sources and interests pages offer, plus the ai-worker's AI test, breakdown and salary lookup (answered
// here with stand-ins). The other AI requests (scoring, translation, ...) belong to the host ai-worker, which e2e does not run.
const poller = runControlPoller({ db, signal: abort.signal, logger: createLogger({ sink: () => {} }), kinds: () => ["run_cycle", "rescore_stale", "run_suggest", "test_channel", "test_telegram", "test_ai", "breakdown_job", "salary_lookup"], pollSeconds: () => POLL_SECONDS });

log("ready");
while (!abort.signal.aborted) {
  await writeHeartbeat(db, "runner").catch(() => {});
  // it answers requests of the ai-worker too, so it beats for it: the waiting buttons judge "offline" by that heartbeat
  await writeHeartbeat(db, "ai-worker").catch(() => {});
  await sleep(HEARTBEAT_MS, undefined, { signal: abort.signal }).catch(() => {});
}
stopWatching();
await poller;
await closeDb();
log("stopped");
