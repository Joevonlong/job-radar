/**
 * The `market_base_salary` data migration gives stored salaries and T1 amounts written while the base was always
 * EUR their base figures; a second run changes nothing, and the readers see the same figures before and after.
 */
import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { annualBaseFigure } from "@/lib/domain/salary";
import { jobSalarySchema } from "@/lib/domain/types";

const url = inject("testDatabaseUrl");
const DRIZZLE = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = fs.readdirSync(DRIZZLE).find((name) => /^\d{4}_market_base_salary\.sql$/.test(name));

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
});
afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
  await closeDb();
});

async function runMigrationAgain(): Promise<void> {
  const text = fs.readFileSync(path.join(DRIZZLE, MIGRATION ?? ""), "utf8");
  for (const statement of text.split("--> statement-breakpoint")) if (statement.trim() !== "") await getDb().execute(sql.raw(statement));
}

const COMMON = { periodAssumed: false, origin: "text", qualityStatus: "valid", reasonCodes: [] } as const;
const OLD_SALARY = { ...COMMON, perYear: { min: 70000, max: 90000 }, min: 70000, max: 90000, currency: "EUR", period: "year", raw: "EUR 70,000 - 90,000", eurPerYear: { min: 70000, max: 90000 } };
const OLD_USD = { ...COMMON, perYear: { min: 100000, max: 120000 }, min: 100000, max: 120000, currency: "USD", period: "year", raw: "$100k - $120k", eurPerYear: { min: 86000, max: 103200 } };
const NO_RATE = { ...COMMON, perYear: { min: 50000, max: 60000 }, min: 50000, max: 60000, currency: "XYZ", period: "year", raw: "XYZ 50,000", eurPerYear: null };

async function seed(): Promise<number[]> {
  const db = getDb();
  const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
  const ids: number[] = [];
  for (const [i, salary] of [OLD_SALARY, OLD_USD, NO_RATE].entries()) {
    const job = await insertJob(db, { companyId: company.id, title: `Job ${i}`, titleNorm: `job ${i}`, salaryJson: salary });
    ids.push(job.id);
    await db.insert(schema.signals).values({ jobId: job.id, tier: "T1", kind: "salary_range", valueJson: { ...salary, raw: undefined }, quote: salary.raw, extractor: "rule" });
  }
  return ids;
}

describe.runIf(MIGRATION !== undefined)("market_base_salary", () => {
  it("adds basePerYear + baseCurrency EUR to old rows, keeps eurPerYear, and a second run changes nothing", async () => {
    const ids = await seed();
    const before = await getDb().select().from(schema.jobs);
    const figuresBefore = before.map((row) => annualBaseFigure(jobSalarySchema.parse(row.salaryJson), "EUR"));

    await runMigrationAgain();
    const after = await getDb().select().from(schema.jobs);
    for (const row of after) {
      const salary = row.salaryJson as Record<string, unknown>;
      expect(salary.baseCurrency).toBe("EUR");
      expect(salary.basePerYear).toEqual(salary.eurPerYear);
    }
    expect(after.map((row) => annualBaseFigure(jobSalarySchema.parse(row.salaryJson), "EUR"))).toEqual(figuresBefore);
    const signals = await getDb().select().from(schema.signals).where(eq(schema.signals.jobId, ids[1] ?? 0));
    expect(signals[0]?.valueJson).toMatchObject({ baseCurrency: "EUR", basePerYear: { min: 86000, max: 103200 } });

    const snapshot = JSON.stringify(await getDb().select().from(schema.jobs));
    await runMigrationAgain();
    expect(JSON.stringify(await getDb().select().from(schema.jobs))).toBe(snapshot);
  });

  it("leaves rows that already carry a base currency alone", async () => {
    const db = getDb();
    const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
    const salary = { ...OLD_USD, eurPerYear: null, basePerYear: { min: 100000, max: 120000 }, baseCurrency: "USD" };
    const job = await insertJob(db, { companyId: company.id, title: "US job", titleNorm: "us job", salaryJson: salary });
    await runMigrationAgain();
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(row?.salaryJson).toEqual(salary);
  });
});
