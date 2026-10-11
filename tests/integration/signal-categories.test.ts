/**
 * Signal categories against Postgres: the `signal_tier` enum becomes text (migration on live data), deleted categories keep their
 * rows through rescans and AI reviews, the high-value rule in SQL, the per-category counts, and the AI review of a
 * user-defined category.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import type { InterestsConfig } from "@/lib/config";
import { closeDb, countSignalsByCategory, getDb, listJobs, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getSignalScan, listSignalsOfJob, saveAiReview } from "@/lib/db/repos/signals";
import { highValuePolicy, reconcileBonuses, runAiReview, runRuleScan, signalsPrompt } from "@/lib/signals";

import { pinnedAi } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";
import { rawCategories, shippedInterests, shippedPipeline } from "../signals/helpers";

const url = inject("testDatabaseUrl");
const pipeline = shippedPipeline();

/** The defaults plus a high-value keyword category `visa`. */
const withVisa = (): InterestsConfig =>
  shippedInterests((raw) => {
    rawCategories(raw).push({ id: "visa", kind: "keyword", label: { en: "Visa sponsorship" }, color: "violet", weight: 4, high_value: true, ai_definition: "the employer sponsors a work visa", keywords: ["visa sponsorship"] });
  });

/** The defaults with T3 deleted (moved to the retired categories). */
const withoutT3 = (): InterestsConfig =>
  shippedInterests((raw) => {
    const categories = rawCategories(raw);
    const [t3] = categories.splice(categories.findIndex((c) => c.id === "T3"), 1);
    (raw.signals as { retired_categories: unknown[] }).retired_categories = [t3];
  });

async function newJob(title: string, description: string, score = 60): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title}`.toLowerCase() }).returning({ id: schema.companies.id });
  const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description }).returning({ id: schema.jobs.id });
  await db.insert(schema.scores).values({ jobId: job!.id, filterResult: "passed", score, rankValue: score });
  return job!.id;
}

const scan = (interests: InterestsConfig) => runRuleScan(getDb(), { interests, pipeline, logger: quietLogger, batchSize: 50 });
const tiersOf = async (jobId: number) => (await listSignalsOfJob(getDb(), jobId)).map((s) => s.tier).sort();
const resetTables = () => getDb().execute(sql`truncate table jobs, companies restart identity cascade`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(resetTables);
afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("migration 0024: signals.tier enum -> text", () => {
  it("keeps every row and value of a database at 0023, adds the format check and drops the type", async () => {
    const admin = new URL(url);
    const name = `${admin.pathname.slice(1)}_m24`;
    const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-mig-"));
    try {
      await adminSql.unsafe(`create database "${name}"`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      // the migrations up to 0023 only
      fs.cpSync(path.resolve("drizzle"), folder, { recursive: true });
      const journalFile = path.join(folder, "meta", "_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      const last = journal.entries.find((entry) => entry.tag.endsWith("_signal_category_text"));
      if (!last) throw new Error("migration not found");
      fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < last.idx) }));
      await runMigrations({ url: target.toString(), migrationsFolder: folder });

      const db = postgres(target.toString(), { max: 1, onnotice: () => {} });
      try {
        await db`insert into companies (name, name_norm) values ('Acme', 'acme')`;
        await db`insert into jobs (company_id, title, title_norm) values (1, 'Job', 'job')`;
        for (const tier of ["T1", "T2", "T3", "T4", "tag"]) await db`insert into signals (job_id, tier, kind, quote, extractor) values (1, ${tier}, 'k', ${`quote ${tier}`}, 'rule')`;
        const before = await db`select id, tier::text as tier, kind, quote from signals order by id`;

        await runMigrations({ url: target.toString() });
        const after = await db`select id, tier, kind, quote from signals order by id`;
        expect(after).toEqual(before);
        const [column] = await db`select data_type from information_schema.columns where table_name = 'signals' and column_name = 'tier'`;
        expect(column?.data_type).toBe("text");
        const [type] = await db`select count(*)::int as n from pg_type where typname = 'signal_tier'`;
        expect(type?.n).toBe(0);
        await db`insert into signals (job_id, tier, kind, quote, extractor) values (1, 'remote-budget_2', 'k', 'q', 'rule')`;
        await expect(db`insert into signals (job_id, tier, kind, quote, extractor) values (1, '9bad id', 'k', 'q', 'rule')`).rejects.toThrow(/signals_tier_format/);
      } finally {
        await db.end({ timeout: 2 });
      }
    } finally {
      await adminSql.unsafe(`drop database if exists "${name}" with (force)`);
      await adminSql.end({ timeout: 2 });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }, 180_000); // a database built from all migrations
});

describe("deleted categories keep their rows", () => {
  it("a rescan replaces the active categories' rows only; the hidden ones bring no bonus; a restore extracts them again", async () => {
    const job = await newJob("Rich", "Competitive salary package. Stock options for all.");
    await scan(shippedInterests());
    expect(await tiersOf(job)).toEqual(["T2", "T3"]);
    // a row of a category this installation never had (or deleted long ago)
    await getDb().insert(schema.signals).values({ jobId: job, tier: "gone", kind: "x", quote: "Stock options for all.", extractor: "rule" });

    const retired = withoutT3();
    expect((await scan(retired)).scanned).toBe(1); // the vocabulary changed
    expect(await tiersOf(job)).toEqual(["T2", "T3", "gone"]);
    await reconcileBonuses(getDb(), retired, null);
    const [score] = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job));
    expect(score).toMatchObject({ signalBonus: 8, rankValue: 68 });

    expect((await countSignalsByCategory(getDb())).get("T3")).toEqual({ signals: 1, jobs: 1 });

    expect((await scan(shippedInterests())).scanned).toBe(1);
    expect(await tiersOf(job)).toEqual(["T2", "T3", "gone"]);
    expect((await countSignalsByCategory(getDb())).get("T3")).toEqual({ signals: 1, jobs: 1 });
  });

  it("an AI review replaces the active categories' rows only", async () => {
    const job = await newJob("Rich", "Competitive salary package.");
    await scan(withoutT3());
    await getDb().insert(schema.signals).values({ jobId: job, tier: "T3", kind: "competitive_pay", quote: "Competitive salary package.", extractor: "rule" });
    const state = await getSignalScan(getDb(), job);
    const stored = await saveAiReview(getDb(), {
      jobId: job,
      descriptionHash: state?.descriptionHash ?? "",
      promptVersion: "test",
      provider: "claude-cli",
      model: "m",
      activeIds: ["T1", "T2", "T4", "tag"],
      signals: [],
    });
    expect(stored).toBe(true);
    expect(await tiersOf(job)).toEqual(["T3"]);
  });
});

describe("high-value signals in SQL", () => {
  it("a user-defined high-value category counts; an amount below the floor does not; without any high-value category nothing does", async () => {
    const visa = await newJob("Visa", "We offer visa sponsorship.");
    const low = await newJob("Low", "Salary: €40,000 per year.");
    const plain = await newJob("Plain", "A competitive salary package.");
    const interests = withVisa();
    await scan(interests);
    const base = { sort: "rank" as const, page: 1, pageSize: 50, timezone: "Europe/Berlin" };
    const high = await listJobs(getDb(), { ...base, filters: { highValue: highValuePolicy(interests, 70000) } });
    expect(high.jobs.map((j) => j.id)).toEqual([visa]);
    const noFloor = await listJobs(getDb(), { ...base, filters: { highValue: highValuePolicy(interests, null) } });
    expect(noFloor.jobs.map((j) => j.id).sort()).toEqual([visa, low].sort());
    const none = shippedInterests((raw) => {
      for (const category of rawCategories(raw)) category.high_value = false;
    });
    expect((await listJobs(getDb(), { ...base, filters: { highValue: highValuePolicy(none, null) } })).total).toBe(0);
    void plain;
  });
});

describe("AI review of a user-defined category", () => {
  it("uses a new prompt version, offers the category to the AI and stores its signal with the verbatim quote", async () => {
    const job = await newJob("Visa", "## Benefits\nWe offer visa sponsorship for international hires.\nCompetitive salary.");
    const interests = withVisa();
    await scan(interests);
    const calls: AiTransportRequest[] = [];
    const transport: AiTransport = {
      id: "claude-cli",
      availability: () => ({ available: true }),
      async call(request) {
        calls.push(request);
        const visaLine = request.user.split("\n").find((l) => l.startsWith("[") && l.includes(" visa:"));
        const id = Number(/^\[(\d+)\]/.exec(visaLine ?? "")?.[1]);
        return { text: JSON.stringify({ signals: [{ tier: "visa", kind: "visa_sponsorship", quote: "x", candidate: id, amount: null }], rejected: [] }), model: "fake", usage: { tokensIn: 1, tokensOut: 1 } };
      },
    };
    const router = createAiRouter({ config: pinnedAi(), providers: [createProvider(transport)], usage: null });
    const result = await runAiReview(getDb(), { router, interests, pipeline, logger: quietLogger, limit: 10 });
    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    expect(calls[0]?.system).toContain("- visa: the employer sponsors a work visa");
    const version = signalsPrompt(interests)?.version;
    expect(version).toMatch(/^signals-v2-/);
    expect((await getSignalScan(getDb(), job))?.aiPromptVersion).toBe(version);
    const rows = await listSignalsOfJob(getDb(), job);
    const visa = rows.find((r) => r.tier === "visa");
    expect(visa).toMatchObject({ quote: "We offer visa sponsorship for international hires.", extractor: "rule" });
    // the T3 candidate the AI did not mention stays as the rules found it
    expect(rows.some((r) => r.tier === "T3")).toBe(true);
  });
});
