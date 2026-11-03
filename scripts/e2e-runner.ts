import { currentScoresBackfill } from "../src/lib/db/current-scores-config";
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
import { z } from "zod";

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
import { createAiRouter, createProvider } from "../src/lib/ai";
import type { AiTransport } from "../src/lib/ai/types";
import { createCompanyResearchHandler } from "../src/lib/control/company-research";
import { createStoryExtractHandler } from "../src/lib/control/story-extract";
import { createWriterJobHandler } from "../src/lib/control/writer-job";

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

await runMigrations({ currentScoresBackfill: currentScoresBackfill() });
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
// "Refresh available models" belongs to the host ai-worker (no network in e2e): answer like it with a fixed three-row list.
registerControlHandler("models_sync", async (request) => {
  await sleep(STUB_TEST_MS);
  const filter = typeof request.payload === "object" && request.payload !== null && "filter" in request.payload ? String(request.payload.filter).toLowerCase() : "";
  const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, textChat: true, price: { input_per_mtok: 0.25, output_per_mtok: 1.25 }, contextLength: 200000, json: "yes", expiresOn: null, inCatalog: false, priceWas: null, addable: true, addableUnverified: false, ...extra });
  const rows = [
    row("e2e/fresh-model", "E2E: Fresh Model"),
    row("e2e/no-json", "E2E: No JSON", { json: "no", addable: false }),
    row("e2e/maybe-json", "E2E: Maybe JSON", { json: "unverified", addable: false, addableUnverified: true }),
  ].filter((r) => r.id.includes(filter));
  return { status: "done", result: { provider: "openrouter", sync: { provider: "openrouter", fetchedAt: new Date().toISOString(), listed: 3, matched: rows.length, truncated: false, rows, gone: [] } } };
});
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

// The application writer belongs to the host ai-worker too: the real handler runs (trap cleaning, the evidence check, the
// stored versions), only the AI is a stand-in. Each version gets a sentence quoting the JD excerpt (backed), a claim
// about you with no evidence (not backed) and a framing sentence.
const writerAi: AiTransport = {
  id: "codex-cli",
  availability: () => ({ available: true }),
  plannedModel: () => "e2e-model",
  async call(request) {
    await sleep(STUB_TEST_MS);
    const input = z
      .object({
        settings: z.object({ versions: z.array(z.object({ id: z.string() })).default([]) }),
        jd_excerpt: z.string().optional(),
        // polish: { text }; coach: { sentences }; coach rewrite: { sentences, suggestions }
        draft: z
          .object({
            text: z.string().optional(),
            sentences: z.array(z.object({ index: z.number(), text: z.string() })).optional(),
            suggestions: z.array(z.object({ index: z.number(), rewrite: z.string() })).optional(),
          })
          .optional(),
      })
      .parse(JSON.parse(request.user.replace(/^<application_input>\n|\n<\/application_input>$/g, "")));
    const draft = input.draft;
    if (draft?.text !== undefined) {
      // polish: every sentence of the draft, each backed by itself, and a framing sentence
      const sentences = draft.text.split(/(?<=[.!?])\s+/).filter((entry) => entry.trim() !== "");
      const variants = input.settings.versions.map((version) => ({
        variant_id: version.id,
        sentences: [
          ...sentences.map((text) => ({ text, about: "user", evidence: [{ source: "draft", quote: text }] })),
          { text: "That is why this role interests me.", about: "framing", evidence: [] },
        ],
      }));
      return { text: JSON.stringify({ variants }), model: "e2e-model", usage: { tokensIn: 100, tokensOut: 50 } };
    }
    if (draft?.sentences !== undefined && draft.suggestions === undefined) {
      // coach: a rating of one configured and one unknown dimension, one backed suggestion and one without evidence
      const first = draft.sentences[0]?.text ?? "";
      const quote = first.replace(/[.!?]$/, "");
      const suggestions = [
        ...(first ? [{ sentence_index: 0, issue: "Say it more directly.", rewrite: `${quote} every single day.`, about: "user", evidence: [{ source: "draft", quote }] }] : []),
        ...(draft.sentences.length > 1 ? [{ sentence_index: 1, issue: "Add a number.", rewrite: "I ran the platform on call for two years.", about: "user", evidence: [] }] : []),
        { sentence_index: 99, issue: "No such sentence.", rewrite: "Nothing.", about: "framing", evidence: [] },
      ];
      const coach = {
        score: 72,
        dimensions: [
          { id: "answers_question", status: "improve", note: "It only half answers the question." },
          { id: "concrete_evidence", status: "good", note: "There are concrete examples." },
          { id: "made_up_dimension", status: "good", note: "Not a configured dimension." },
        ],
        suggestions,
      };
      return { text: JSON.stringify(coach), model: "e2e-model", usage: { tokensIn: 100, tokensOut: 50 } };
    }
    if (draft?.suggestions !== undefined) {
      // coach rewrite: the draft's sentences with the suggested ones in place
      const rewrites = new Map(draft.suggestions.map((entry) => [entry.index, entry.rewrite]));
      const variants = input.settings.versions.map((version) => ({
        variant_id: version.id,
        sentences: (draft.sentences ?? []).map((sentence) => ({ text: rewrites.get(sentence.index) ?? sentence.text, about: "framing", evidence: [] })),
      }));
      return { text: JSON.stringify({ variants }), model: "e2e-model", usage: { tokensIn: 100, tokensOut: 50 } };
    }
    const line = input.jd_excerpt?.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
    const quote = line.slice(0, 80).trim();
    const variants = input.settings.versions.map((version) => ({
      variant_id: version.id,
      sentences: [
        ...(quote ? [{ text: `The posting asks for this: "${quote}".`, about: "role", evidence: [{ source: "jd", quote }] }] : []),
        { text: "I scaled the team to 20 people.", about: "user", evidence: [] },
        { text: "That is why this role interests me.", about: "framing", evidence: [] },
      ],
    }));
    return { text: JSON.stringify({ variants }), model: "e2e-model", usage: { tokensIn: 100, tokensOut: 50 } };
  },
};
registerControlHandler(
  "writer_job",
  createWriterJobHandler({
    createRouter: () => createAiRouter({ config: loadConfig("ai"), providers: [createProvider(writerAi)], usage: null, health: null, quota: null, catalog: null, origin: "control" }),
  }),
);

// The company background too: the real handler runs (the checks of the answer, the stored result), only the AI is a stand-in
// and nothing leaves the machine. One field has a source that is not https: the check must drop it.
const researchAi: AiTransport = {
  id: "claude-cli",
  availability: () => ({ available: true }),
  plannedModel: () => "e2e-model",
  async call() {
    await sleep(STUB_TEST_MS);
    const fact = (text: string, url: string) => ({ text, source_url: url });
    return {
      text: JSON.stringify({
        summary: fact("Builds analytics software for manufacturers.", "https://www.example-analytics.de/about"),
        industry: fact("Industrial software", "https://www.example-analytics.de/about"),
        size: { ...fact("About 120 people", "https://www.linkedin.com/company/example-analytics"), employees: 120 },
        founded: null,
        headquarters: fact("Bremen, Germany", "https://www.example-analytics.de/imprint"),
        funding: fact("Rumoured Series B", "http://news.example-site.de/analytics"),
        products: null,
        workingLanguage: null,
        reviews: null,
        recentNews: { ...fact("Opened a second office\nHired a new CTO", "https://news.example-site.de/analytics"), date: "2026-09-12" },
      }),
      model: "e2e-model",
      usage: { tokensIn: 100, tokensOut: 50 },
    };
  },
};
registerControlHandler(
  "company_research",
  createCompanyResearchHandler({
    createRouter: () => createAiRouter({ config: loadConfig("ai"), providers: [createProvider(researchAi)], usage: null, health: null, quota: null, catalog: null, origin: "control" }),
  }),
);

// Story extraction, from the text it was sent: one draft that passes the check (with the first line of the source as its
// quote) and one with a quote the source does not have, so the review shows both.
const storyAi: AiTransport = {
  id: "codex-cli",
  availability: () => ({ available: true }),
  plannedModel: () => "e2e-model",
  async call(request) {
    await sleep(STUB_TEST_MS);
    const source = request.user.replace(/<\/?story_source>/g, "");
    const line = source.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
    const field = (value: string, quote: string) => ({ value, quote });
    const drafts = [
      { title: field(line.slice(0, 60), line.slice(0, 60)), what: field(line, line), result: null, period: null, metrics: [], skills: [], language: "en" },
      { title: field("Invented achievement", "not in the source at all"), what: field("Cut costs by 60%.", "cut costs by 40%"), result: null, period: null, metrics: [field("60% lower costs", "cut costs by 40%")], skills: [], language: "en" },
    ];
    return { text: JSON.stringify({ drafts }), model: "e2e-model", usage: { tokensIn: 100, tokensOut: 50 } };
  },
};
registerControlHandler(
  "story_extract",
  createStoryExtractHandler({
    createRouter: () => createAiRouter({ config: loadConfig("ai"), providers: [createProvider(storyAi)], usage: null, health: null, quota: null, catalog: null, origin: "control" }),
  }),
);

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

// What the settings, sources and interests pages offer, plus the ai-worker's AI test, breakdown, salary lookup, company background and writer (answered
// here with stand-ins). The other AI requests (scoring, translation, ...) belong to the host ai-worker, which e2e does not run.
const poller = runControlPoller({ db, signal: abort.signal, logger: createLogger({ sink: () => {} }), kinds: () => ["run_cycle", "rescore_stale", "run_suggest", "test_channel", "test_telegram", "test_ai", "models_sync", "breakdown_job", "salary_lookup", "company_research", "story_extract", "writer_job"], pollSeconds: () => POLL_SECONDS });

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
