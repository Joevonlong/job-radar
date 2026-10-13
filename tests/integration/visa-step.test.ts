/**
 * The visa check as a part of the cycle's `signals` step: it runs after the trap scan, a failure makes the step `partial` (never
 * an exception), and `job_checks.visa.enabled: false` in ui.yaml skips it. Synthetic JDs only.
 */
import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import type { CycleStepContext } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { loadPipeline } from "@/lib/market/effective";
import { signalsStep } from "@/lib/signals";
import { VISA_RULES_VERSION } from "@/lib/visa/fingerprint";
import { visaRulesFor } from "@/lib/visa/rules";
import { runVisaScan } from "@/lib/visa/step";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";

/** Switches of the mocks below, and the order the job checks ran in. */
const hooks = vi.hoisted(() => ({ enabled: true, detectThrows: false, rulesThrow: false, order: [] as string[] }));

vi.mock("@/lib/visa/settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/visa/settings")>();
  return { ...original, readVisaSettings: () => ({ ...original.readVisaSettings(), enabled: hooks.enabled }) };
});

vi.mock("@/lib/visa/detect", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/visa/detect")>();
  return {
    ...original,
    detectVisa: (...args: Parameters<typeof original.detectVisa>) => {
      if (hooks.detectThrows) throw new Error("detect failed");
      return original.detectVisa(...args);
    },
  };
});

vi.mock("@/lib/visa/rules", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/visa/rules")>();
  return {
    ...original,
    visaRulesFor: (...args: Parameters<typeof original.visaRulesFor>) => {
      if (hooks.rulesThrow) throw new Error("rules failed");
      return original.visaRulesFor(...args);
    },
  };
});

vi.mock("@/lib/traps/cycle", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/traps/cycle")>();
  return {
    ...original,
    runTrapScanStep: (...args: Parameters<typeof original.runTrapScanStep>) => {
      hooks.order.push("trap");
      return original.runTrapScanStep(...args);
    },
  };
});

vi.mock("@/lib/visa/step", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/visa/step")>();
  return {
    ...original,
    runVisaScanStep: (...args: Parameters<typeof original.runVisaScanStep>) => {
      hooks.order.push("visa");
      return original.runVisaScanStep(...args);
    },
  };
});

const url = inject("testDatabaseUrl");
const REFUSED = "We build data tools.\nWe are unable to offer visa sponsorship for this role.";

function ctx(): CycleStepContext {
  return { cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: getDb(), signal: new AbortController().signal, logger: quietLogger, now: () => new Date(), config: cycleConfig(), channels: undefined as never, results: {} };
}

async function addJob(description: string): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: "Visa Step Co", nameNorm: "visa step co" }).returning({ id: schema.companies.id });
  const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, title: "Data Engineer", titleNorm: "data engineer", description, status: "active" }).returning({ id: schema.jobs.id });
  return job!.id;
}

const visaRow = async (jobId: number) => (await getDb().select().from(schema.jobVisa).where(eq(schema.jobVisa.jobId, jobId)))[0];
const resetTables = () => getDb().execute(sql`truncate table job_visa, jobs, companies restart identity cascade`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await resetTables();
  Object.assign(hooks, { enabled: true, detectThrows: false, rulesThrow: false, order: [] });
});

afterEach(() => vi.clearAllMocks());

afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("the visa check in the signals step", () => {
  it("runs after the trap scan and stores the result", async () => {
    const job = await addJob(REFUSED);
    const result = await signalsStep(ctx());
    expect(hooks.order).toEqual(["trap", "visa"]);
    expect(result.status).toBe("ok");
    expect(result.result).toMatchObject({ visa: { scanned: 1, changed: 1, failed: 0 } });
    expect(await visaRow(job)).toMatchObject({ status: "not_offered" });
  });

  it("makes the step partial when a job fails, and goes on with the rest of the step", async () => {
    const job = await addJob(REFUSED);
    hooks.detectThrows = true;
    const result = await signalsStep(ctx());
    expect(result.status).toBe("partial");
    expect(result.result).toMatchObject({ visa: { failed: 1 }, scan: { scanned: 1 } });
    expect(await visaRow(job)).toBeUndefined();
  });

  it("makes the step partial when the whole check throws, never throwing itself", async () => {
    await addJob(REFUSED);
    hooks.rulesThrow = true;
    const result = await signalsStep(ctx());
    expect(result.status).toBe("partial");
    expect(result.result).toMatchObject({ visa: { error: expect.stringContaining("rules failed") as unknown }, scan: { scanned: 1 } });
  });

  it("checks again a result stored under an earlier detection version", async () => {
    const job = await addJob(REFUSED);
    // the fingerprint `visaRulesFingerprint` gave the same config with the version before this one
    const pipeline = loadPipeline();
    const visa = pipeline.job_checks.visa;
    const limits = { max_quotes: visa.max_quotes, quote_max_chars: visa.quote_max_chars, negation_words_before: visa.negation_words_before, negation_words_after: visa.negation_words_after, heading_max_chars: visa.heading_max_chars };
    const earlier = createHash("sha256").update(JSON.stringify({ version: VISA_RULES_VERSION - 1, pack: pipeline.visa, limits })).digest("hex").slice(0, 32);
    await runVisaScan(getDb(), { rules: visaRulesFor(pipeline), rulesHash: earlier, limit: 10, logger: quietLogger });
    const stored = await visaRow(job);
    expect(stored).toMatchObject({ status: "not_offered" });
    const result = await signalsStep(ctx());
    expect(result.result).toMatchObject({ visa: { scanned: 1, failed: 0 } });
    expect((await visaRow(job))?.inputHash).not.toBe(stored?.inputHash);
    // current now: the next step checks nothing
    expect((await signalsStep(ctx())).result).toMatchObject({ visa: { scanned: 0 } });
  });

  it("is skipped when ui.yaml turns it off", async () => {
    const job = await addJob(REFUSED);
    hooks.enabled = false;
    const result = await signalsStep(ctx());
    expect(result.status).toBe("ok");
    expect(result.result).toMatchObject({ visa: { skipped: "disabled" } });
    expect(await visaRow(job)).toBeUndefined();
  });
});
