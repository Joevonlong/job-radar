import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport } from "@/lib/ai/types";
import type { JobSalary } from "@/lib/domain/types";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getSignalScan, listSignalsOfJob } from "@/lib/db/repos/signals";
import { buildSalary } from "@/lib/pipeline/salary";
import { reconcileBonuses, runAiReview, runRuleScan, syncSalarySignals } from "@/lib/signals";

import { pinnedAi } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";
import { shippedInterests, shippedPipeline } from "../signals/helpers";

const url = inject("testDatabaseUrl");
const pipeline = shippedPipeline();
const interests = shippedInterests();
const options = { interests, pipeline, logger: quietLogger, batchSize: 50 };

const salaryOf = (raw: string, min: number | null, max: number | null, origin: JobSalary["origin"] = "channel", currency = "EUR"): JobSalary =>
  buildSalary({ raw, currency, period: "year", min, max, periodAssumed: false, origin }, pipeline);

async function newJob(title: string, description: string, salary: JobSalary | null): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title}`.toLowerCase() }).returning({ id: schema.companies.id });
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description, salaryJson: salary })
    .returning({ id: schema.jobs.id });
  await db.insert(schema.scores).values({ jobId: job!.id, filterResult: "passed" });
  return job!.id;
}

const t1Of = async (jobId: number) => (await listSignalsOfJob(getDb(), jobId)).filter((s) => s.tier === "T1");
const bonusOf = async (jobId: number) => Number((await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, jobId)))[0]!.signalBonus);
const resetTables = () => getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(resetTables);
afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("T1 from the job's salary", () => {
  it("quotes the source's own salary field (quote_source structured, no JD offset), whatever the JD says", async () => {
    const job = await newJob("AI Engineer", "Build agents with us in Berlin.", salaryOf("€75,000.00/yr - €100,000.00/yr", 75000, 100000));
    await runRuleScan(getDb(), options);
    const [t1, ...rest] = await t1Of(job);
    expect(rest).toEqual([]);
    expect(t1).toMatchObject({
      kind: "salary_range",
      quote: "€75,000.00/yr - €100,000.00/yr",
      quoteSource: "structured",
      quoteOffset: null,
      extractor: "rule",
      value: { currency: "EUR", min: 75000, max: 100000, eurPerYear: { min: 75000, max: 100000 }, stated: { period: "year" }, fromSalary: true },
    });
    expect((await reconcileBonuses(getDb(), interests, 70000)).updated).toBe(1);
    expect(await bonusOf(job)).toBe(10);
  });

  it("applies the salary floor: the range's top counts, an amount below the floor is shown but brings no bonus", async () => {
    const touching = await newJob("Touching", "x", salaryOf("€50,000.00/yr - €70,000.00/yr", 50000, 70000));
    const below = await newJob("Below", "x", salaryOf("€40,000/yr - €60,000/yr", 40000, 60000));
    await runRuleScan(getDb(), options);
    expect(await t1Of(below)).toHaveLength(1);
    await reconcileBonuses(getDb(), interests, 70000);
    expect(await bonusOf(touching)).toBe(10); // max 70,000 is not below the 70,000 floor
    expect(await bonusOf(below)).toBe(0);
  });

  it("quotes a description salary from the description, and drops the JD hits that only repeat it", async () => {
    const description = "Intro.\nSalary range (annual brutto): €60.000 EUR - €80.000 EUR Show more\nWe may also pay up to €70,000 for seniors.";
    const salary = salaryOf("Salary range (annual brutto): €60.000 EUR - €80.000 EUR", 60000, 80000, "description");
    const job = await newJob("Data Scientist", description, salary);
    await runRuleScan(getDb(), options);
    const t1 = await t1Of(job);
    expect(t1.map((s) => [s.quoteSource, s.quote, s.value && (s.value as { max: number }).max])).toEqual([["description", "Salary range (annual brutto): €60.000 EUR - €80.000 EUR", 80000]]);
    expect(description.slice(t1[0]!.quoteOffset ?? -1, (t1[0]!.quoteOffset ?? 0) + t1[0]!.quote.length)).toBe(t1[0]!.quote);
  });

  it("makes none from a salary that needs review or that the description does not contain", async () => {
    const review = await newJob("Review", "x", buildSalary({ raw: "Relocation up to 2,500", currency: "EUR", period: null, min: 2500, max: 4, periodAssumed: false, origin: "description" }, pipeline));
    const missing = await newJob("Missing", "A different text.", salaryOf("Salary €90,000", 90000, 90000, "description"));
    await runRuleScan(getDb(), options);
    expect(await t1Of(review)).toEqual([]);
    expect(await t1Of(missing)).toEqual([]);
  });

  it("keeps a JD amount the salary does not cover", async () => {
    const job = await newJob("OTE", "Base: €80,000 - €100,000 per year.\nTarget earnings including variable pay: up to €150,000 per year.", salaryOf("€80,000/yr - €100,000/yr", 80000, 100000));
    await runRuleScan(getDb(), options);
    expect((await t1Of(job)).map((s) => [s.quoteSource, (s.value as { max: number }).max])).toEqual([
      ["structured", 100000],
      ["description", 150000],
    ]);
  });
});

describe("the salary signal follows the salary", () => {
  const noAnswer: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call() {
      return { text: JSON.stringify({ signals: [], rejected: [] }), model: "fake-model", usage: { tokensIn: 10, tokensOut: 5 } };
    },
  };
  const router = () => createAiRouter({ config: pinnedAi(), providers: [createProvider(noAnswer)], usage: null });

  it("replaces it when the salary changes, without a rescan and without a new AI review", async () => {
    const job = await newJob("AI Engineer", "Build agents. Equity for everyone.", salaryOf("€75,000/yr - €100,000/yr", 75000, 100000));
    await runRuleScan(getDb(), options);
    await runAiReview(getDb(), { router: router(), interests, pipeline, logger: quietLogger, limit: 10 });
    const before = await getSignalScan(getDb(), job);
    expect(before?.aiScannedAt).not.toBeNull();
    expect((await t1Of(job))[0]).toMatchObject({ quoteSource: "structured" }); // the AI review keeps it
    expect((await listSignalsOfJob(getDb(), job)).map((s) => s.tier)).toEqual(["T1", "T2"]);

    expect(await syncSalarySignals(getDb(), options)).toMatchObject({ synced: 0 }); // nothing changed

    await getDb().update(schema.jobs).set({ salaryJson: salaryOf("€90,000/yr - €120,000/yr", 90000, 120000) }).where(eq(schema.jobs.id, job));
    expect(await runRuleScan(getDb(), options)).toMatchObject({ scanned: 0 }); // the JD did not change
    expect(await syncSalarySignals(getDb(), options)).toEqual({ synced: 1, withSalarySignal: 1, failed: 0 });
    expect((await t1Of(job)).map((s) => [s.quote, (s.value as { min: number }).min])).toEqual([["€90,000/yr - €120,000/yr", 90000]]);
    expect((await listSignalsOfJob(getDb(), job)).map((s) => s.tier)).toEqual(["T1", "T2"]); // the AI-reviewed rest is untouched
    const after = await getSignalScan(getDb(), job);
    expect(after?.aiScannedAt).toEqual(before?.aiScannedAt);
    expect(after?.scannedAt).toEqual(before?.scannedAt);

    await getDb().update(schema.jobs).set({ salaryJson: null }).where(eq(schema.jobs.id, job));
    expect(await syncSalarySignals(getDb(), options)).toEqual({ synced: 1, withSalarySignal: 0, failed: 0 });
    expect(await t1Of(job)).toEqual([]);
  });

  it("starts for scans made before the salary signal existed (no salary hash yet)", async () => {
    const job = await newJob("AI Engineer", "Build agents.", salaryOf("€75,000/yr - €100,000/yr", 75000, 100000));
    await runRuleScan(getDb(), options);
    await getDb().update(schema.signalScans).set({ salaryHash: null }).where(eq(schema.signalScans.jobId, job));
    await getDb().delete(schema.signals).where(eq(schema.signals.jobId, job));
    expect(await syncSalarySignals(getDb(), options)).toMatchObject({ synced: 1, withSalarySignal: 1 });
    expect(await t1Of(job)).toHaveLength(1);
  });

  it("brings back a JD amount the old salary had made redundant when the salary goes away", async () => {
    const job = await newJob("Band", "Salary: €80,000 - €100,000 per year.", salaryOf("Salary: €80,000 - €100,000 per year", 80000, 100000, "description"));
    await runRuleScan(getDb(), options);
    expect(await t1Of(job)).toHaveLength(1);
    await getDb().update(schema.jobs).set({ salaryJson: null }).where(eq(schema.jobs.id, job));
    await syncSalarySignals(getDb(), options);
    // the rule scan only reruns when the JD changes: the redundant JD hit is not restored by a sync
    expect(await t1Of(job)).toEqual([]);
  });
});
