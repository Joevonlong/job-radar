/**
 * The visa check against a real database: the stored scan (idempotent, rescans on a changed JD / rules / hidden JD piece), the
 * /jobs filter, the list badge, the detail result, the degrade before the migration, and `pnpm visa:scan`. Synthetic JDs only.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, listJobs, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { resetCheckTablesCache } from "@/lib/db/repos/job-checks";
import { resetTrapTablesCache } from "@/lib/db/repos/traps";
import { getVisaOfJob, loadVisaStatuses } from "@/lib/db/repos/visa";
import { loadPipeline } from "@/lib/market";
import { visaRulesFingerprint } from "@/lib/visa/fingerprint";
import { visaRulesFor } from "@/lib/visa/rules";
import { runVisaScan, type VisaScanOptions } from "@/lib/visa/step";

import { FIXTURE_DEFAULTS_DIR, makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");
const db = () => getDb();

const OFFERED = "We build data tools.\nWe offer visa sponsorship and relocation support for this role.";
const REFUSED = "We build data tools.\nWe are unable to offer visa sponsorship for this role.";
const PERMIT = "We build data tools.\nYou must hold a valid work permit for Germany.";
const UNCLEAR = "We build data tools.\nQuestions about visas and relocation? Ask us in the first call.";
const PLAIN = "We build data tools.\n- Python and SQL\nWe offer 30 days of vacation.";

let temp: TempConfig;
let counter = 0;

async function addJob(description: string | null, options: { company?: string; status?: "active" | "closed" } = {}): Promise<number> {
  counter += 1;
  const name = options.company ?? `Visa Test Co ${counter}`;
  const [company] = await db().insert(schema.companies).values({ name, nameNorm: name.toLowerCase() }).onConflictDoNothing().returning();
  const companyId = company?.id ?? (await db().select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.nameNorm, name.toLowerCase())))[0]!.id;
  const [job] = await db()
    .insert(schema.jobs)
    .values({ companyId, title: `Data Engineer ${counter}`, titleNorm: `data engineer ${counter}`, description, language: "en", status: options.status ?? "active", firstSeenAt: new Date(NOW.getTime() - counter * 60_000) })
    .returning();
  return job!.id;
}

function options(over: Partial<VisaScanOptions> = {}): VisaScanOptions {
  const pipeline = loadPipeline();
  return { rules: visaRulesFor(pipeline), rulesHash: visaRulesFingerprint(pipeline), limit: 100, logger: quietLogger, ...over };
}

const scan = (over: Partial<VisaScanOptions> = {}) => runVisaScan(db(), options(over));
const row = async (jobId: number) => (await db().select().from(schema.jobVisa).where(eq(schema.jobVisa.jobId, jobId)))[0];
const ids = async (visa: "offered" | "not_denied" | null) =>
  (await listJobs(db(), { filters: { visa }, sort: "first_seen", page: 1, pageSize: 50, timezone: "Europe/Berlin" })).jobs.map((j) => j.id).sort((a, b) => a - b);

const TABLES = "job_visa, job_traps, trap_scans, jobs, companies, scores, signals, signal_scans";

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  temp = makeTempConfig();
});

afterEach(() => temp.cleanup());

afterAll(async () => {
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  await closeDb();
});

describe("the stored visa check", () => {
  it("stores each state with verbatim quotes; a second run checks nothing", async () => {
    const offered = await addJob(OFFERED);
    const refused = await addJob(REFUSED);
    const permit = await addJob(PERMIT);
    const unclear = await addJob(UNCLEAR);
    const plain = await addJob(PLAIN);
    const empty = await addJob(null);

    const first = await scan();
    expect(first).toMatchObject({ scanned: 6, changed: 6, failed: 0 });
    expect((await row(offered))?.status).toBe("offered");
    expect((await row(refused))?.status).toBe("not_offered");
    expect((await row(permit))?.evidence).toEqual([expect.objectContaining({ status: "not_offered", kind: "permit_required" })]);
    expect((await row(unclear))?.status).toBe("unclear");
    expect(await row(plain)).toMatchObject({ status: "not_mentioned", evidence: [] });
    expect((await row(empty))?.status).toBe("not_mentioned");
    for (const [jobId, text] of [
      [offered, OFFERED],
      [refused, REFUSED],
      [permit, PERMIT],
    ] as const) {
      for (const e of (await getVisaOfJob(db(), jobId))?.evidence ?? []) expect(text.slice(e.offset, e.offset + e.quote.length)).toBe(e.quote);
    }

    expect(await scan()).toMatchObject({ scanned: 0, changed: 0 });
    // a forced run of the same inputs changes nothing either
    expect(await scan({ jobIds: [offered], force: true })).toMatchObject({ scanned: 1, changed: 0 });
  });

  it("checks a job again when its JD or the rules change, and a preview writes nothing", async () => {
    const jobId = await addJob(PLAIN);
    await scan();
    await db().update(schema.jobs).set({ description: REFUSED }).where(eq(schema.jobs.id, jobId));
    const preview = await scan({ write: false });
    expect(preview).toMatchObject({ scanned: 1, changed: 1 });
    expect((await row(jobId))?.status).toBe("not_mentioned");
    expect(await scan()).toMatchObject({ scanned: 1, changed: 1 });
    expect((await row(jobId))?.status).toBe("not_offered");
    // other rules: every job is listed again, the result stays the same
    expect(await scan({ rulesHash: "other-rules" })).toMatchObject({ scanned: 1, changed: 0 });
    expect(await scan({ rulesHash: "other-rules" })).toMatchObject({ scanned: 0 });
  });

  it("checks never-checked jobs first and only open ones, at most the limit", async () => {
    const closed = await addJob(OFFERED, { status: "closed" });
    const a = await addJob(OFFERED);
    const b = await addJob(REFUSED);
    expect((await scan({ limit: 1 })).outcomes.map((o) => o.jobId)).toHaveLength(1);
    const rest = await scan();
    expect(rest.scanned).toBe(1);
    expect(await row(closed)).toBeUndefined();
    expect(new Set([(await row(a))?.status, (await row(b))?.status])).toEqual(new Set(["offered", "not_offered"]));
    // a closed job is checked when named
    expect(await scan({ jobIds: [closed] })).toMatchObject({ scanned: 1 });
  });

  it("drops hits inside hidden JD text (trap findings) and checks again when they change", async () => {
    const hidden = "We offer visa sponsorship and relocation support for this role.";
    const jobId = await addJob(OFFERED);
    await db().insert(schema.trapScans).values({ jobId, descriptionHash: "d", sourcesHash: "s", rulesHash: "r", trapCount: 1, spansHash: "spans-1" });
    await db().insert(schema.jobTraps).values({
      jobId,
      layer: "ai",
      technique: "css_hidden",
      severity: "trap",
      quote: hidden,
      quoteSource: "description",
      quoteOffset: OFFERED.indexOf(hidden),
      location: "description",
      inDescription: true,
    });
    resetTrapTablesCache();
    await scan();
    expect((await row(jobId))?.status).toBe("not_mentioned");
    // the finding goes away: the hidden-pieces hash changes, the job is checked again
    await db().delete(schema.jobTraps).where(eq(schema.jobTraps.jobId, jobId));
    await db().update(schema.trapScans).set({ spansHash: null }).where(eq(schema.trapScans.jobId, jobId));
    expect(await scan()).toMatchObject({ scanned: 1, changed: 1 });
    expect((await row(jobId))?.status).toBe("offered");
  });

  it("counts only combined phrases on a company named like a visa word", async () => {
    const jobId = await addJob("Visa is a global payments company.\nVisa support teams help merchants worldwide.", { company: "Visa" });
    await scan();
    expect((await row(jobId))?.status).toBe("not_mentioned");
  });

  it("touches no score, signal or JD", async () => {
    const jobId = await addJob(REFUSED);
    const before = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    await scan();
    expect(await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId))).toEqual(before);
    expect(await db().select().from(schema.scores)).toEqual([]);
    expect(await db().select().from(schema.signals)).toEqual([]);
  });
});

describe("what the pages read", () => {
  it("filters /jobs: offered only, or everything but refusals (unchecked jobs stay)", async () => {
    const offered = await addJob(OFFERED);
    const refused = await addJob(REFUSED);
    const permit = await addJob(PERMIT);
    const unclear = await addJob(UNCLEAR);
    await scan();
    const unchecked = await addJob(REFUSED);
    expect(await ids("offered")).toEqual([offered]);
    expect(await ids("not_denied")).toEqual([offered, unclear, unchecked].sort((a, b) => a - b));
    expect(await ids(null)).toEqual([offered, refused, permit, unclear, unchecked].sort((a, b) => a - b));
  });

  it("gives the list badge the clear results and the detail page the quotes", async () => {
    const offered = await addJob(OFFERED);
    const permit = await addJob(PERMIT);
    const unclear = await addJob(UNCLEAR);
    await scan();
    const statuses = await loadVisaStatuses(db(), [offered, permit, unclear]);
    expect(statuses.get(offered)).toEqual({ status: "offered", kind: null });
    expect(statuses.get(permit)).toEqual({ status: "not_offered", kind: "permit_required" });
    expect(statuses.has(unclear)).toBe(false);
    const cards = (await listJobs(db(), { filters: {}, sort: "first_seen", page: 1, pageSize: 50, timezone: "Europe/Berlin" })).jobs;
    expect(cards.find((c) => c.id === permit)?.visa).toEqual({ status: "not_offered", kind: "permit_required" });
    expect(cards.find((c) => c.id === unclear)?.visa ?? null).toBeNull();
    const detail = await getJobDetail(db(), permit);
    expect(detail?.visa).toMatchObject({ status: "not_offered", kind: "permit_required", evidence: [expect.objectContaining({ quote: "You must hold a valid work permit for Germany." })] });
  });

  it("degrades before the migration: nothing checked, nothing written, no filter condition fails", async () => {
    const jobId = await addJob(OFFERED);
    resetCheckTablesCache();
    await db()
      .transaction(async (tx) => {
        await tx.execute(sql`alter table job_visa rename to job_visa_moved`);
        const result = await runVisaScan(tx, options());
        expect(result).toMatchObject({ skipped: "no_table", scanned: 0 });
        expect(await getVisaOfJob(tx, jobId)).toBeNull();
        expect((await loadVisaStatuses(tx, [jobId])).size).toBe(0);
        throw new Error("rollback");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback") throw error;
      });
    resetCheckTablesCache();
    expect(await scan()).toMatchObject({ scanned: 1 });
  });
});

describe("pnpm visa:scan", () => {
  const APP_ROOT = path.resolve(import.meta.dirname, "../..");
  const TSX = path.join(APP_ROOT, "node_modules/.bin/tsx");
  const run = (args: string[]) =>
    spawnSync(TSX, ["scripts/visa-scan.ts", ...args], {
      cwd: APP_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: os.tmpdir(),
        DATABASE_URL: url,
        DB_CONNECT_TIMEOUT_SECONDS: "30",
        JOB_RADAR_DEFAULTS_DIR: FIXTURE_DEFAULTS_DIR,
        JOB_RADAR_CONFIG_DIR: temp.configDir,
        JOB_RADAR_PROFILE_DIR: temp.profileDir,
        JOB_RADAR_CONFIG_POLL_MS: "0",
        NODE_ENV: "test",
      },
    });

  it("previews, writes, then has nothing left to change", async () => {
    const offered = await addJob(OFFERED);
    await addJob(PERMIT);
    const preview = run(["--json"]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ write: false, scanned: 2, changed: 2 });
    expect(await row(offered)).toBeUndefined();

    const write = run(["--write", "--json"]);
    expect(JSON.parse(write.stdout)).toMatchObject({ write: true, scanned: 2, changed: 2, stats: { byStatus: { offered: 1, not_offered: 1 }, notOfferedByKind: { permit_required: 1 }, unchecked: 0 } });
    expect((await row(offered))?.status).toBe("offered");

    expect(JSON.parse(run(["--write", "--json"]).stdout)).toMatchObject({ scanned: 0, changed: 0 });
    expect(JSON.parse(run(["--job", String(offered), "--json"]).stdout)).toMatchObject({ scanned: 1, changed: 0, jobs: [expect.objectContaining({ jobId: offered, status: "offered" })] });
  }, 120_000);

  it("rejects an unknown flag with the usage", () => {
    const result = run(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("visa:scan");
  }, 60_000);
});
