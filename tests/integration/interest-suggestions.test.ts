import { withRebuiltCurrentScores } from "../helpers/current-scores";
import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { parse, stringify } from "yaml";

import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { AiProviderError } from "@/lib/ai/errors";
import { ensureProfileFiles, resetConfigCache } from "@/lib/config";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { createRunSuggestHandler } from "@/lib/control/suggest";
import { closeDb, getDb, insertControlRequest, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { listSuggestions } from "@/lib/db/repos/interest-suggestions";
import { runSuggest, type SuggestDeps } from "@/lib/interests/suggest";
import { sendSuggestionsNotice } from "@/lib/interests/suggest-notify";
import { enqueueSuggestRequest, isWeeklySuggestOverdue } from "@/lib/interests/suggest-schedule";
import { approveSuggestion, rejectSuggestion } from "@/lib/interests/suggestion-apply";
import { loadSuggestionsSection } from "@/lib/interests/suggestion-view";

import { shippedYaml, makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";
import { FakeBotApi, FAKE_TOKEN } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";
import { aiConfig } from "../scoring/helpers";
import { shippedSuggest } from "../interests/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");
const DAY = 24 * 3_600_000;
const db = () => getDb();
let temp: TempConfig;
const api = new FakeBotApi();

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  await api.start();
});

const TABLES = "control_requests, interest_suggestions, profile_snapshots, scores, signals, signal_scans, applications, jobs, companies, notifications, ai_usage";

beforeEach(async () => {
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  temp = makeTempConfig();
  await ensureProfileFiles();
  api.reset();
});

afterEach(() => {
  resetControlHandlers();
  temp.cleanup();
});

afterAll(async () => {
  await api.stop();
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  await closeDb();
});

// ---------------------------------------------------------------- data

interface SeedJob {
  title?: string;
  company: string;
  description: string;
  status: "interested" | "applied" | "archived" | "new";
  daysAgo?: number;
  city?: string;
}

const companyIds = new Map<string, number>();

/** A company, a job and an application in `status` that changed `daysAgo` before NOW. Returns the job id. */
async function seed(job: SeedJob): Promise<number> {
  let companyId = companyIds.get(job.company);
  if (companyId === undefined) {
    const [company] = await db()
      .insert(schema.companies)
      .values({ name: job.company, nameNorm: job.company.toLowerCase().replace(/\s+/g, "-") })
      .returning();
    companyId = company!.id;
    companyIds.set(job.company, companyId);
  }
  const [row] = await db()
    .insert(schema.jobs)
    .values({
      companyId,
      title: job.title ?? `${job.company} role`,
      titleNorm: (job.title ?? `${job.company} role`).toLowerCase(),
      description: job.description,
      locationsJson: [{ label: job.city ?? "Berlin", city: job.city ?? "Berlin", countryCode: "DE", isPrimary: true }],
    })
    .returning();
  await db()
    .insert(schema.applications)
    .values({ jobId: row!.id, status: job.status, statusChangedAt: new Date(NOW.getTime() - (job.daysAgo ?? 1) * DAY) });
  return row!.id;
}

const QUOTE = "We pay a wellness budget of 500 euro per year.";

/** Three liked jobs (two with the quote), two ignored ones. Returns their ids. */
async function seedUsual() {
  companyIds.clear();
  const liked1 = await seed({ company: "Northwind Labs", description: `Build agents. ${QUOTE} Join us.`, status: "interested" });
  const liked2 = await seed({ company: "Northwind Labs", description: `LLM platform. ${QUOTE}`, status: "applied", daysAgo: 3 });
  const liked3 = await seed({ company: "Acme AI", description: "Agents in Hamburg.", status: "interested", city: "Hamburg" });
  const ignored1 = await seed({ company: "Legacy Bank", title: "Cobol Developer", description: "Maintain Cobol systems.", status: "archived" });
  const ignored2 = await seed({ company: "Legacy Bank", title: "Cobol Architect", description: "Design Cobol landscapes.", status: "archived", daysAgo: 2 });
  await seed({ company: "Old News", description: "Interested a year ago.", status: "interested", daysAgo: 400 });
  return { liked1, liked2, liked3, ignored1, ignored2 };
}

// ---------------------------------------------------------------- fake AI

interface FakeAi {
  calls: AiTransportRequest[];
  deps: SuggestDeps;
}

/** A provider that answers with `answer(request)`; no real CLI or API is reachable from here. */
function fakeAi(answer: (request: AiTransportRequest) => unknown, options: { fail?: Error; notify?: SuggestDeps["notify"] } = {}): FakeAi {
  const calls: AiTransportRequest[] = [];
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request) {
      calls.push(request);
      if (options.fail) throw options.fail;
      return { text: JSON.stringify(answer(request)), model: "fake-model", usage: { tokensIn: 10, tokensOut: 10 } };
    },
  };
  const config = aiConfig();
  return {
    calls,
    deps: {
      db: db(),
      router: createAiRouter({ config, providers: [createProvider(transport)], usage: null }),
      aiConfig: config,
      logger: quietLogger,
      now: () => NOW,
      notify: options.notify ?? (async () => "disabled"),
    },
  };
}

const reasons = { reason_zh: "两个岗位都提到", reason_en: "Both jobs mention it", confidence: 0.85 };

function usualAnswer(ids: Awaited<ReturnType<typeof seedUsual>>) {
  return {
    signal_words: [
      { tier: "benefit_tag", term: "wellness budget", ...reasons, evidence: [{ job_id: ids.liked1, quote: QUOTE }, { job_id: ids.liked2, quote: QUOTE }] },
      // a quote the JD does not contain: thrown away
      { tier: "T2", term: "phantom units", ...reasons, evidence: [{ job_id: ids.liked1, quote: "We grant phantom units." }, { job_id: ids.liked2, quote: "Phantom units for all." }] },
    ],
    companies: [{ company: "Northwind Labs", ...reasons, evidence_job_ids: [ids.liked1, ids.liked2] }],
    filters: [
      { action: "exclude_keyword", value: "Cobol", ...reasons, evidence_job_ids: [ids.ignored1, ids.ignored2] },
      { action: "add_location", value: "Hamburg", ...reasons, confidence: 0.4, evidence_job_ids: [ids.liked3] },
    ],
  };
}

const interestsFile = () => path.join(temp.configDir, "interests.yaml");
const preferencesFile = () => path.join(temp.profileDir, "preferences.yaml");
const readYaml = (file: string): Record<string, unknown> => parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------- runSuggest

describe("runSuggest", () => {
  it("stores the suggestions that are backed by evidence, as pending, and drops the rest", async () => {
    const ids = await seedUsual();
    const fake = fakeAi(() => usualAnswer(ids));
    const summary = await runSuggest(fake.deps);

    expect(summary).toMatchObject({ status: "done", liked: 3, ignored: 2, proposed: 5, accepted: 3, stored: 3, provider: "claude-cli" });
    expect(summary.dropped).toEqual({ no_valid_evidence: 1, low_confidence: 1 });
    expect(fake.calls).toHaveLength(1);
    // the prompt carries both groups and the JDs, but not the job from a year ago
    const prompt = fake.calls[0]?.user ?? "";
    expect(prompt).toContain(`<job id="${ids.liked1}" status="interested">`);
    expect(prompt).toContain(`<job id="${ids.ignored1}" status="archived">`);
    expect(prompt).toContain(QUOTE);
    expect(prompt).not.toContain("Interested a year ago");
    expect(fake.calls[0]?.strong).toBe(true);

    const rows = await listSuggestions(db(), { status: "pending", limit: 20 });
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(["filter:exclude_keyword:cobol", "signal_word:wellness budget", "watched_company:northwind-labs"]);
    const word = rows.find((r) => r.kind === "signal_word");
    expect(word?.payloadJson).toMatchObject({
      term: "wellness budget",
      evidence: [{ jobId: ids.liked1, quote: QUOTE }, { jobId: ids.liked2, quote: QUOTE }],
    });
    // nothing was applied
    expect(readYaml(interestsFile()).watched_companies).toEqual([]);
    expect(await db().select().from(schema.aiUsage)).toHaveLength(0);
  });

  it("does not propose the same thing twice, whatever happened to it", async () => {
    const ids = await seedUsual();
    const first = await runSuggest(fakeAi(() => usualAnswer(ids)).deps);
    expect(first.stored).toBe(3);

    const word = (await listSuggestions(db(), { status: "pending", limit: 20 })).find((r) => r.kind === "signal_word")!;
    expect(await rejectSuggestion(word.id)).toMatchObject({ status: "rejected" });

    const second = await runSuggest(fakeAi(() => usualAnswer(ids)).deps);
    expect(second).toMatchObject({ accepted: 0, stored: 0 });
    expect(second.dropped.seen_before).toBe(3);
    expect(await db().select().from(schema.interestSuggestions)).toHaveLength(3);
  });

  it("asks nothing when too few jobs were liked in the window", async () => {
    companyIds.clear();
    await seed({ company: "Solo", description: "x", status: "interested" });
    await seed({ company: "Late", description: "x", status: "interested", daysAgo: 60 });
    const fake = fakeAi(() => ({}));
    const summary = await runSuggest(fake.deps);
    expect(summary).toMatchObject({ status: "skipped", skipped: "too_few_liked_jobs", liked: 1, stored: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it("caps the stored suggestions at max_suggestions, most confident first", async () => {
    const ids = await seedUsual();
    const suggest = shippedSuggest((raw) => (raw.max_suggestions = 1));
    const summary = await runSuggest({ ...fakeAi(() => usualAnswer(ids)).deps, loadSuggestConfig: () => suggest });
    expect(summary).toMatchObject({ accepted: 3, stored: 1 });
    expect(summary.dropped.over_limit).toBe(2);
  });

  it("lets the error out when no provider can answer, and stores nothing", async () => {
    await seedUsual();
    const fake = fakeAi(() => ({}), { fail: new AiProviderError("claude-cli", "auth", "login expired") });
    await expect(runSuggest(fake.deps)).rejects.toThrow();
    expect(await db().select().from(schema.interestSuggestions)).toHaveLength(0);
  });

  it("uses the statuses and window of the config", async () => {
    const ids = await seedUsual();
    const suggest = shippedSuggest((raw) => (raw.positive_statuses = ["applied"]));
    const summary = await runSuggest({ ...fakeAi(() => usualAnswer(ids)).deps, loadSuggestConfig: () => suggest });
    expect(summary).toMatchObject({ status: "skipped", liked: 1 });
  });
});

// ---------------------------------------------------------------- approve / reject

describe("approving and rejecting", () => {
  async function stored() {
    const ids = await seedUsual();
    await runSuggest(fakeAi(() => usualAnswer(ids)).deps);
    const rows = await listSuggestions(db(), { status: "pending", limit: 20 });
    const byKind = (kind: string) => rows.find((r) => r.kind === kind)!;
    return { ids, word: byKind("signal_word"), company: byKind("watched_company"), filter: byKind("filter") };
  }

  it("approve writes the word into interests.yaml (comments kept), marks it approved and recomputes the ranking", async () => {
    const { word, ids } = await stored();
    const before = fs.readFileSync(interestsFile(), "utf8");
    // a scored job, so the recompute has something to check
    const [snapshot] = await db().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "x", hash: "h" }).returning();
    await withRebuiltCurrentScores(db(), db().insert(schema.scores).values({ jobId: ids.liked1, profileSnapshotId: snapshot!.id, filterResult: "passed", score: 80, rankValue: 80 }));
    await db().insert(schema.signals).values({ jobId: ids.liked1, tier: "T3", kind: "competitive_pay", quote: "competitive salary", extractor: "rule" });

    const result = await approveSuggestion(word.id);
    expect(result).toMatchObject({ status: "approved", change: "added", recompute: { reconciled: true, checked: 1, updated: 1, rescanPending: true, rescorePending: false } });
    // the bonus of T3 (3 points) is now in the rank value: the ranking was recomputed, no AI involved
    const [score] = await db().select().from(schema.scores).where(eq(schema.scores.jobId, ids.liked1));
    expect(score).toMatchObject({ signalBonus: 3, rankValue: 83 });

    // The stored `benefit_tag` goes into the first tag category
    const interests = readYaml(interestsFile()) as { signals: { categories: Array<{ id: string; tags?: string[] }> } };
    expect(interests.signals.categories.find((c) => c.id === "tag")?.tags).toContain("wellness budget");
    const after = fs.readFileSync(interestsFile(), "utf8");
    expect(after).toContain("# 福利标签：只显示，不加分");
    expect(after.split("\n").length).toBeGreaterThanOrEqual(before.split("\n").length);
    const [row] = await db().select().from(schema.interestSuggestions).where(eq(schema.interestSuggestions.id, word.id));
    expect(row).toMatchObject({ status: "approved" });
    expect(row?.decidedAt).not.toBeNull();
    // the loader (the page) no longer lists it as pending
    const view = await loadSuggestionsSection();
    expect(view.pending.map((p) => p.id)).not.toContain(word.id);
    expect(view.decided.map((p) => p.id)).toContain(word.id);
  });

  it("approve of a company and of a filter writes interests.yaml / preferences.yaml, the latter with a profile snapshot", async () => {
    const { company, filter } = await stored();
    expect(await approveSuggestion(company.id)).toMatchObject({ status: "approved", change: "added" });
    expect(readYaml(interestsFile()).watched_companies).toEqual(["Northwind Labs"]);

    expect(await approveSuggestion(filter.id)).toMatchObject({ status: "approved", change: "added", recompute: { rescorePending: true, reconciled: false } });
    expect(readYaml(preferencesFile()).exclude_keywords).toEqual(["Cobol"]);
    expect(await db().select().from(schema.profileSnapshots).where(eq(schema.profileSnapshots.kind, "preferences"))).not.toHaveLength(0);
  });

  it("approving a value the user already added by hand changes nothing", async () => {
    const { company } = await stored();
    const file = interestsFile();
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("watched_companies: []", "watched_companies: [northwind labs]"));
    resetConfigCache();
    expect(await approveSuggestion(company.id)).toMatchObject({ status: "approved", change: "alreadyPresent" });
    expect(readYaml(file).watched_companies).toEqual(["northwind labs"]);
  });

  it("reject leaves the files alone and the suggestion is never proposed again", async () => {
    const { filter } = await stored();
    const before = fs.readFileSync(preferencesFile(), "utf8");
    expect(await rejectSuggestion(filter.id)).toMatchObject({ status: "rejected" });
    expect(fs.readFileSync(preferencesFile(), "utf8")).toBe(before);
    expect((await db().select().from(schema.interestSuggestions).where(eq(schema.interestSuggestions.id, filter.id)))[0]).toMatchObject({ status: "rejected" });
  });

  it("a suggestion is decided once: a second click or tab gets alreadyDecided and nothing is written twice", async () => {
    const { company } = await stored();
    const [first, second] = await Promise.all([approveSuggestion(company.id), approveSuggestion(company.id)]);
    expect([first.status, second.status].sort()).toEqual(["approved", "error"]);
    expect(readYaml(interestsFile()).watched_companies).toEqual(["Northwind Labs"]);
    expect(await rejectSuggestion(company.id)).toMatchObject({ status: "error", error: "alreadyDecided" });
    expect(await approveSuggestion(999999)).toMatchObject({ status: "error", error: "notFound" });
    expect(await approveSuggestion("1; drop table")).toMatchObject({ status: "error", error: "invalidPayload" });
  });

  it("when the config cannot be read the suggestion goes back to pending and nothing is lost", async () => {
    const { company } = await stored();
    fs.writeFileSync(interestsFile(), "signals: [unterminated\n");
    resetConfigCache();
    expect(await approveSuggestion(company.id)).toMatchObject({ status: "error", error: "unreadable" });
    expect((await db().select().from(schema.interestSuggestions).where(eq(schema.interestSuggestions.id, company.id)))[0]).toMatchObject({ status: "pending", decidedAt: null });
  });

  it("a payload that does not fit the schema is reported as unreadable and can be rejected", async () => {
    const [row] = await db().insert(schema.interestSuggestions).values({ kind: "signal_word", dedupeKey: "bad", payloadJson: { kind: "signal_word", tier: "T9" } }).returning();
    expect(await approveSuggestion(row!.id)).toMatchObject({ status: "error", error: "unreadableSuggestion" });
    expect((await loadSuggestionsSection()).pending[0]).toMatchObject({ id: row!.id, payload: null });
    expect(await rejectSuggestion(row!.id)).toMatchObject({ status: "rejected" });
  });
});

// ---------------------------------------------------------------- control request and schedule

describe("the run_suggest control request", () => {
  const poll = () => ({ db: db(), signal: new AbortController().signal, logger: quietLogger });

  it("without a registered handler the request fails visibly", async () => {
    await insertControlRequest(db(), { kind: "run_suggest" });
    expect(await processNextControlRequest(poll())).toMatchObject({ status: "failed", result: { error: "no_handler" } });
  });

  it("runs runSuggest and records the summary", async () => {
    const ids = await seedUsual();
    const fake = fakeAi(() => usualAnswer(ids));
    registerControlHandler("run_suggest", createRunSuggestHandler({ createDeps: () => fake.deps }));
    const { id } = await enqueueSuggestRequest(db());
    const finished = await processNextControlRequest(poll());
    expect(finished).toMatchObject({ id, status: "done", result: { status: "done", stored: 3, liked: 3 } });
    const view = await loadSuggestionsSection();
    expect(view.pending).toHaveLength(3);
    expect(view.lastRun).toMatchObject({ status: "done", stored: 3, skipped: null, error: null });
  });

  it("a failing AI fails the request with a code, not the runner", async () => {
    await seedUsual();
    const fake = fakeAi(() => ({}), { fail: new AiProviderError("claude-cli", "auth", "login expired") });
    registerControlHandler("run_suggest", createRunSuggestHandler({ createDeps: () => fake.deps }));
    await enqueueSuggestRequest(db());
    expect(await processNextControlRequest(poll())).toMatchObject({ status: "failed", result: { error: "suggest_failed" } });
    expect((await loadSuggestionsSection()).lastRun).toMatchObject({ status: "failed", error: "suggest_failed" });
  });

  it("enqueue reuses a request that is still open", async () => {
    const first = await enqueueSuggestRequest(db());
    expect(first.existing).toBe(false);
    expect(await enqueueSuggestRequest(db())).toEqual({ id: first.id, existing: true });
  });

  it("catch-up: overdue until a request exists since the latest slot", async () => {
    const config = shippedSuggest();
    const wednesday = new Date("2026-10-07T10:00:00Z");
    expect(await isWeeklySuggestOverdue(db(), config, "Europe/Berlin", wednesday)).toBe(true);
    await db().execute(sql`insert into control_requests (kind, requested_at) values ('run_suggest', ${new Date("2026-10-05T06:01:00Z").toISOString()})`);
    expect(await isWeeklySuggestOverdue(db(), config, "Europe/Berlin", wednesday)).toBe(false);
    expect(await isWeeklySuggestOverdue(db(), { ...config, enabled: false }, "Europe/Berlin", new Date("2026-10-20T10:00:00Z"))).toBe(false);
  });
});

// ---------------------------------------------------------------- telegram

describe("the Telegram reminder", () => {
  // the fake Bot API is a local server: a custom endpoint, so the opt-in is set
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: "555", JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" };

  function configureNotify(edit: (raw: { telegram: Record<string, unknown>; quiet_hours: Record<string, unknown> } & Record<string, unknown>) => void = () => {}) {
    const config = notifyConfig((raw) => {
      Object.assign(raw.telegram, { enabled: true, api_base_url: api.url, max_retries: 0 });
      Object.assign(raw.quiet_hours, { enabled: false });
      edit(raw);
    });
    fs.writeFileSync(path.join(temp.configDir, "notify.yaml"), stringify(config));
    resetConfigCache();
  }

  it("one message when a run stored new suggestions; none when it found nothing", async () => {
    configureNotify();
    const ids = await seedUsual();
    const notify: SuggestDeps["notify"] = (payloads) => sendSuggestionsNotice({ db: db(), logger: quietLogger, payloads, env, now: () => NOW });
    const summary = await runSuggest(fakeAi(() => usualAnswer(ids), { notify }).deps);
    expect(summary.notice).toBe("sent");
    const sent = api.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.text)).toContain("本周有 3 条新的兴趣建议");
    expect(await db().select().from(schema.notifications).where(eq(schema.notifications.kind, "interest_suggestions"))).toHaveLength(1);

    // the same answer again: everything was seen before, so no message
    const again = await runSuggest(fakeAi(() => usualAnswer(ids), { notify }).deps);
    expect(again).toMatchObject({ stored: 0 });
    expect(again.notice).toBeUndefined();
    expect(api.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("respects notify.yaml, quiet hours, missing credentials and suggest.notify", async () => {
    const payloads = [] as Parameters<NonNullable<SuggestDeps["notify"]>>[0];
    configureNotify((raw) => Object.assign(raw.telegram, { enabled: false }));
    expect(await sendSuggestionsNotice({ db: db(), logger: quietLogger, payloads, env })).toBe("disabled");

    configureNotify((raw) => Object.assign(raw.quiet_hours, { enabled: true, start: "22:00", end: "09:00" }));
    expect(await sendSuggestionsNotice({ db: db(), logger: quietLogger, payloads, env, now: () => new Date("2026-10-07T04:00:00Z") })).toBe("quiet");

    configureNotify();
    expect(await sendSuggestionsNotice({ db: db(), logger: quietLogger, payloads, env: {} })).toBe("not_configured");
    expect(api.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);

    const ids = await seedUsual();
    const silent = fakeAi(() => usualAnswer(ids), { notify: async () => "sent" });
    const quiet = await runSuggest({ ...silent.deps, loadSuggestConfig: () => shippedSuggest((raw) => (raw.notify = false)) });
    expect(quiet.stored).toBe(3);
    expect(quiet.notice).toBeUndefined();
  });

  it("a failing Telegram does not fail the run", async () => {
    configureNotify();
    api.failNext("sendMessage", 500, { ok: false, description: "boom" }, 5);
    const sent = await sendSuggestionsNotice({ db: db(), logger: quietLogger, payloads: [], env, now: () => NOW });
    expect(sent).toBe("failed");
  });
});

// keep the shipped YAML honest: the tests above rely on the defaults of schedule.yaml
describe("shipped config", () => {
  it("is what the tests assume", () => {
    expect(shippedYaml("schedule.yaml").suggest).toMatchObject({ min_positive_jobs: 3, lookback_weeks: 4 });
  });
});
