/**
 * The ghost job check against a real database: the stored check (idempotent, checks again on changed inputs / rules / the next
 * "open for long" tier), the /jobs filter, the list mark, the dismissal, the step inside `signals`, the degrade before the
 * migration, and `pnpm ghost:check`. Synthetic jobs and rules built here; nothing reads the shipped config.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import YAML from "yaml";

import type { CycleStepContext } from "@/lib/cycle/steps";
import { closeDb, getDb, listJobs, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { clearGhostDismissed, countGhostStats, getGhostOfJob, loadGhostLevels, setGhostDismissed } from "@/lib/db/repos/ghost";
import { resetCheckTablesCache } from "@/lib/db/repos/job-checks";
import { ghostChannels, type GhostChannel } from "@/lib/ghost/inputs";
import { runGhostCheck, type GhostCheckOptions } from "@/lib/ghost/step";
import type { GhostFilter } from "@/lib/ghost/types";
import { signalsStep } from "@/lib/signals";

import { FIXTURE_DEFAULTS_DIR, makeTempConfig, type TempConfig } from "../config/helpers";
import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { FULL_JD, rulesWith } from "../ghost/helpers";

const hooks = vi.hoisted(() => ({ enabled: true, trustedKeys: [] as string[] }));

vi.mock("@/lib/ghost/settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ghost/settings")>();
  return {
    ...original,
    readGhostSettings: () => ({ enabled: hooks.enabled, trusted_companies: [] }),
    ghostEnabled: () => hooks.enabled,
    ghostTrustedKeys: () => [...hooks.trustedKeys],
  };
});

const url = inject("testDatabaseUrl");
const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-07T10:00:00Z");
const daysAgo = (days: number, from = NOW) => new Date(from.getTime() - days * DAY_MS);
const db = () => getDb();

const POOL = "We collect CVs for our talent pool.";

/** A test channel with stable ids, the full text and a trusted posted date (`{ posted }` in its payload). */
const ats: GhostChannel = {
  id: "ghost-ats",
  stableExternalIds: true,
  fullDescription: true,
  trustedPostedAt: true,
  parse: (payload) => ({ postedAt: new Date((payload as { posted: string }).posted) }) as unknown as ReturnType<GhostChannel["parse"]>,
};
/** A board without any of the declarations. */
const board: GhostChannel = { id: "ghost-board", parse: () => ({ postedAt: null }) as unknown as ReturnType<GhostChannel["parse"]> };
const channels = ghostChannels([ats, board]);

const rules = rulesWith(() => {}, {
  evergreen_patterns: [{ id: "pool", pattern: "talent pool", check_negation: true }],
  responsibility_patterns: [{ id: "duties", pattern: "responsibilities" }],
  negation_cues: ["not"],
});

function options(over: Partial<GhostCheckOptions> = {}): GhostCheckOptions {
  return { rules, rulesHash: "rules-v1", channels, trustedKeys: [], limit: 100, logger: quietLogger, now: NOW, ...over };
}
const check = (over: Partial<GhostCheckOptions> = {}) => runGhostCheck(db(), options(over));

let counter = 0;
let temp: TempConfig;

async function addJob(description: string | null, opts: { company?: string; seenDaysAgo?: number; status?: "active" | "closed" } = {}): Promise<number> {
  counter += 1;
  const name = opts.company ?? `Ghost Test Co ${counter}`;
  const [company] = await db().insert(schema.companies).values({ name, nameNorm: name.toLowerCase() }).returning();
  const [job] = await db()
    .insert(schema.jobs)
    .values({ companyId: company!.id, title: `Data Engineer ${counter}`, titleNorm: `data engineer ${counter}`, description, language: "en", status: opts.status ?? "active", firstSeenAt: daysAgo(opts.seenDaysAgo ?? 10) })
    .returning();
  return job!.id;
}

async function addSource(jobId: number, opts: { channel?: string; id: string; seenDaysAgo: number; postedDaysAgo?: number; location?: string; priority?: number }): Promise<void> {
  const channelId = opts.channel ?? ats.id;
  const payload = opts.postedDaysAgo === undefined ? { n: opts.id } : { n: opts.id, posted: daysAgo(opts.postedDaysAgo).toISOString() };
  const [raw] = await db().insert(schema.rawPostings).values({ channelId, externalId: opts.id, payloadJson: payload }).returning();
  await db()
    .insert(schema.jobSources)
    .values({ jobId, rawPostingId: raw!.id, channelId, locationLabel: opts.location ?? "Berlin, Germany", priority: opts.priority ?? 1, firstSeenAt: daysAgo(opts.seenDaysAgo) });
}

/** likely: open 200 days (2) + relisted (2) + talent pool (2) + thin (1) = 7. */
async function likelyJob(): Promise<number> {
  const id = await addJob(POOL, { seenDaysAgo: 120 });
  await addSource(id, { id: `l-${id}-a`, seenDaysAgo: 120, postedDaysAgo: 200 });
  await addSource(id, { id: `l-${id}-b`, seenDaysAgo: 10 });
  return id;
}
/** watch: talent pool (2) + open 100 days from first seen (1) = 3; a board source keeps no full text (no thin). */
async function watchJob(): Promise<number> {
  const id = await addJob(POOL, { seenDaysAgo: 100 });
  await addSource(id, { channel: board.id, id: `w-${id}`, seenDaysAgo: 100 });
  return id;
}
async function cleanJob(): Promise<number> {
  const id = await addJob(FULL_JD, { seenDaysAgo: 10 });
  await addSource(id, { id: `c-${id}`, seenDaysAgo: 10, postedDaysAgo: 10 });
  return id;
}

const row = async (jobId: number) => (await db().select().from(schema.jobGhost).where(eq(schema.jobGhost.jobId, jobId)))[0];
const listIds = async (ghost: GhostFilter | null) =>
  (await listJobs(db(), { filters: { ghost }, sort: "first_seen", page: 1, pageSize: 50, timezone: "Europe/Berlin", ghost: true })).jobs.map((j) => j.id).sort((a, b) => a - b);
const sorted = (...ids: number[]) => ids.sort((a, b) => a - b);

const TABLES = "job_ghost, job_sources, raw_postings, jobs, companies, scores, signals, signal_scans";

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  await db()
    .insert(schema.channels)
    .values([
      { id: ats.id, family: "ats", kind: "ats" },
      { id: board.id, family: "board", kind: "guest" },
    ])
    .onConflictDoNothing();
  hooks.enabled = true;
  hooks.trustedKeys = [];
  temp = makeTempConfig();
});

afterEach(() => temp.cleanup());

afterAll(async () => {
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  await db().execute(sql`delete from channels where id in ('ghost-ats', 'ghost-board')`);
  await closeDb();
});

describe("the stored ghost job check", () => {
  it("stores each level with its reasons; a second run checks nothing", async () => {
    const likely = await likelyJob();
    const watch = await watchJob();
    const clean = await cleanJob();
    expect(await check()).toMatchObject({ scanned: 3, changed: 3, failed: 0 });
    expect(await row(likely)).toMatchObject({ level: "likely", score: 7 });
    expect(((await row(likely))?.evidence as Array<{ code: string }>).map((r) => r.code)).toEqual(["long_open", "reposted", "evergreen_wording", "thin_description"]);
    expect(await row(watch)).toMatchObject({ level: "watch", score: 3 });
    expect(await row(clean)).toMatchObject({ level: "none", score: 0 });
    expect(await check()).toMatchObject({ scanned: 0, changed: 0 });
  });

  it("checks again on a changed JD, source or rules; a preview writes nothing", async () => {
    const clean = await cleanJob();
    const other = await cleanJob();
    await check();
    await db().update(schema.jobs).set({ description: POOL }).where(eq(schema.jobs.id, clean));
    expect(await check({ write: false })).toMatchObject({ scanned: 1, changed: 1 });
    expect((await row(clean))?.level).toBe("none");
    expect(await check()).toMatchObject({ scanned: 1, changed: 1 });
    await addSource(other, { id: `extra-${other}`, seenDaysAgo: 1, location: "Munich, Germany" });
    expect(await check()).toMatchObject({ scanned: 1 });
    expect(await check({ rulesHash: "rules-v2" })).toMatchObject({ scanned: 2 });
  });

  it("checks a job again when it reaches the next open-for-long tier (recheck_at)", async () => {
    const id = await addJob(FULL_JD, { seenDaysAgo: 100 });
    await addSource(id, { id: `t-${id}`, seenDaysAgo: 100, postedDaysAgo: 100 });
    await check();
    expect((await row(id))?.recheckAt?.toISOString()).toBe(new Date(daysAgo(100).getTime() + 180 * DAY_MS).toISOString());
    expect(await check({ now: new Date(NOW.getTime() + 79 * DAY_MS) })).toMatchObject({ scanned: 0 });
    expect(await check({ now: new Date(NOW.getTime() + 81 * DAY_MS) })).toMatchObject({ scanned: 1 });
  });

  it("never flags a trusted company, and skips closed jobs", async () => {
    const likely = await likelyJob();
    const closed = await addJob(POOL, { status: "closed", seenDaysAgo: 300 });
    const company = (await db().select({ name: schema.companies.nameNorm }).from(schema.companies).innerJoin(schema.jobs, eq(schema.jobs.companyId, schema.companies.id)).where(eq(schema.jobs.id, likely)))[0]!.name;
    expect(await check({ trustedKeys: [company] })).toMatchObject({ scanned: 1 });
    expect(await row(likely)).toMatchObject({ level: "none", score: 0, evidence: [] });
    expect(await row(closed)).toBeUndefined();
  });

  it("touches no score, signal or JD", async () => {
    const id = await likelyJob();
    await db().insert(schema.scores).values({ jobId: id, filterResult: "passed", score: 71, rankValue: 71.5 });
    await db().insert(schema.signals).values({ jobId: id, tier: "T1", kind: "salary", quote: "EUR 70,000 per year", extractor: "rule" });
    const before = { jobs: await db().select().from(schema.jobs).where(eq(schema.jobs.id, id)), scores: await db().select().from(schema.scores), signals: await db().select().from(schema.signals) };
    expect(before.scores).toHaveLength(1);
    expect(before.signals).toHaveLength(1);
    await check();
    expect((await row(id))?.level).toBe("likely");
    expect({ jobs: await db().select().from(schema.jobs).where(eq(schema.jobs.id, id)), scores: await db().select().from(schema.scores), signals: await db().select().from(schema.signals) }).toEqual(before);
  });
});

describe("what the pages read", () => {
  it("filters /jobs: only = watch + likely, hide = without likely, all = everything (unchecked jobs stay)", async () => {
    const likely = await likelyJob();
    const watch = await watchJob();
    const clean = await cleanJob();
    await check();
    const unchecked = await addJob(POOL);
    expect(await listIds("only")).toEqual(sorted(likely, watch));
    expect(await listIds("hide")).toEqual(sorted(watch, clean, unchecked));
    expect(await listIds("all")).toEqual(sorted(likely, watch, clean, unchecked));
    expect(await listIds(null)).toEqual(sorted(likely, watch, clean, unchecked));
  });

  it("gives the list its marks (strongest reasons first) and the detail page the reasons", async () => {
    const likely = await likelyJob();
    const clean = await cleanJob();
    await check();
    const cards = (await listJobs(db(), { filters: {}, sort: "first_seen", page: 1, pageSize: 50, timezone: "Europe/Berlin", ghost: true })).jobs;
    expect(cards.find((c) => c.id === likely)?.ghost).toMatchObject({ level: "likely", score: 7 });
    expect(cards.find((c) => c.id === likely)?.ghost?.top.map((r) => r.code)).toEqual(["long_open", "reposted", "evergreen_wording", "thin_description"]);
    expect(cards.find((c) => c.id === clean)?.ghost ?? null).toBeNull();
    // the marks are not loaded while the check is off
    const off = (await listJobs(db(), { filters: {}, sort: "first_seen", page: 1, pageSize: 50, timezone: "Europe/Berlin" })).jobs;
    expect(off.find((c) => c.id === likely)?.ghost ?? null).toBeNull();
    const detail = await getJobDetail(db(), likely);
    expect(detail?.ghost).toMatchObject({ level: "likely", dismissed: false, reasons: expect.arrayContaining([expect.objectContaining({ code: "evergreen_wording", quote: POOL })]) as unknown });
  });

  it("a dismissal hides the mark until a new kind of reason comes up; undo brings it back", async () => {
    const watch = await watchJob();
    await check();
    expect(await setGhostDismissed(db(), watch)).toBe(true);
    expect((await getGhostOfJob(db(), watch))?.dismissed).toBe(true);
    expect((await loadGhostLevels(db(), [watch])).has(watch)).toBe(false);
    expect(await listIds("only")).toEqual([]);
    expect(await countGhostStats(db())).toMatchObject({ byLevel: { watch: 1 }, dismissed: 1 });

    expect(await clearGhostDismissed(db(), watch)).toBe(true);
    expect((await loadGhostLevels(db(), [watch])).get(watch)?.level).toBe("watch");
    await setGhostDismissed(db(), watch);

    // a source that keeps the full text: the short JD becomes a new reason (thin_description)
    await addSource(watch, { id: `full-${watch}`, seenDaysAgo: 1, priority: 0 });
    await check();
    expect((await getGhostOfJob(db(), watch))?.dismissed).toBe(false);
    expect((await loadGhostLevels(db(), [watch])).has(watch)).toBe(true);
    expect(await listIds("only")).toEqual([watch]);
  });

  it("hides a trusted company's marks at once, before the check runs again (closed jobs too)", async () => {
    const likely = await likelyJob();
    const watch = await watchJob();
    const closed = await likelyJob();
    await check();
    await db().update(schema.jobs).set({ status: "closed" }).where(eq(schema.jobs.id, closed));
    const keyOf = async (jobId: number) => (await db().select({ name: schema.companies.nameNorm }).from(schema.companies).innerJoin(schema.jobs, eq(schema.jobs.companyId, schema.companies.id)).where(eq(schema.jobs.id, jobId)))[0]!.name;
    const keys = [await keyOf(likely), await keyOf(closed)];
    expect((await loadGhostLevels(db(), [likely, watch, closed], keys)).size).toBe(1);
    expect((await loadGhostLevels(db(), [likely, watch, closed])).size).toBe(3);
    expect(await getGhostOfJob(db(), likely, keys)).toMatchObject({ level: "none", score: 0, reasons: [], dismissed: false });
    expect(await getGhostOfJob(db(), closed, keys)).toMatchObject({ level: "none" });
    expect(await getGhostOfJob(db(), watch, keys)).toMatchObject({ level: "watch" });
    // the pages read ui.yaml's list (mocked here): the filter, the list mark and the detail page
    hooks.trustedKeys = keys;
    expect(await listIds("only")).toEqual([watch]);
    expect(await listIds("hide")).toEqual(sorted(likely, watch));
    const cards = (await listJobs(db(), { filters: {}, sort: "first_seen", page: 1, pageSize: 50, timezone: "Europe/Berlin", ghost: true })).jobs;
    expect(cards.find((c) => c.id === likely)?.ghost ?? null).toBeNull();
    expect((await getJobDetail(db(), likely))?.ghost).toMatchObject({ level: "none" });
    // the stored result is untouched: the next cycle stores "none" itself
    expect((await row(likely))?.level).toBe("likely");
  });

  it("a clear result cannot be dismissed", async () => {
    const clean = await cleanJob();
    await check();
    expect(await setGhostDismissed(db(), clean)).toBe(false);
  });

  it("degrades before the migration: nothing checked, nothing read, no stats", async () => {
    const id = await likelyJob();
    resetCheckTablesCache();
    await db()
      .transaction(async (tx) => {
        await tx.execute(sql`alter table job_ghost rename to job_ghost_moved`);
        expect(await runGhostCheck(tx, options())).toMatchObject({ skipped: "no_table", scanned: 0 });
        expect(await getGhostOfJob(tx, id)).toBeNull();
        expect((await loadGhostLevels(tx, [id])).size).toBe(0);
        expect(await countGhostStats(tx)).toBeNull();
        expect(await setGhostDismissed(tx, id)).toBe(false);
        throw new Error("rollback");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback") throw error;
      });
    resetCheckTablesCache();
    expect(await check()).toMatchObject({ scanned: 1 });
  });
});

describe("the ghost job check in the signals step", () => {
  const ctx = (): CycleStepContext => ({ cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: db(), signal: new AbortController().signal, logger: quietLogger, now: () => NOW, config: cycleConfig(), channels: undefined as never, results: {} });

  it("runs after the other checks and stores results", async () => {
    const id = await addJob("This posting is for our talent pool.", { seenDaysAgo: 5 });
    const result = await signalsStep(ctx());
    expect(result.status).toBe("ok");
    expect(result.result).toMatchObject({ ghost: { scanned: 1, failed: 0 } });
    expect(await row(id)).toBeDefined();
  });

  it("is skipped when ui.yaml turns it off", async () => {
    const id = await addJob(POOL);
    hooks.enabled = false;
    const result = await signalsStep(ctx());
    expect(result.result).toMatchObject({ ghost: { skipped: "disabled" } });
    expect(await row(id)).toBeUndefined();
  });
});

describe("pnpm ghost:check", () => {
  const APP_ROOT = path.resolve(import.meta.dirname, "../..");
  const TSX = path.join(APP_ROOT, "node_modules/.bin/tsx");
  const enableInUi = (enabled: boolean) => {
    const file = path.join(temp.configDir, "ui.yaml");
    const doc = (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, "utf8")) : null) ?? {};
    doc.job_checks = { ...doc.job_checks, ghost: { enabled, trusted_companies: [] } };
    fs.writeFileSync(file, YAML.stringify(doc));
  };
  const run = (args: string[]) =>
    spawnSync(TSX, ["scripts/ghost-check.ts", ...args], {
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

  it("previews while off, refuses --write while off, writes once on, then has nothing left to change", async () => {
    const id = await addJob("This posting is for our talent pool.", { seenDaysAgo: 5 });
    await addJob(FULL_JD, { seenDaysAgo: 5 });
    enableInUi(false);
    const preview = run(["--json"]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ write: false, enabled: false, scanned: 2, changed: 2 });
    expect(await row(id)).toBeUndefined();
    expect(run(["--write"]).status).toBe(1);

    enableInUi(true);
    const write = run(["--write", "--json"]);
    expect(write.status, write.stderr).toBe(0);
    expect(JSON.parse(write.stdout)).toMatchObject({ write: true, enabled: true, scanned: 2, changed: 2, stats: { unchecked: 0, total: 2 } });
    expect(await row(id)).toBeDefined();
    expect(JSON.parse(run(["--write", "--json"]).stdout)).toMatchObject({ scanned: 0, changed: 0 });
    // a preview reads every open job, also the current ones (the share of each level), unless --limit says otherwise
    expect(JSON.parse(run(["--json"]).stdout)).toMatchObject({ write: false, scanned: 2, changed: 0 });
    expect(JSON.parse(run(["--json", "--limit", "1"]).stdout)).toMatchObject({ scanned: 1 });
    expect(JSON.parse(run(["--job", String(id), "--json"]).stdout)).toMatchObject({ scanned: 1, changed: 0, jobs: [expect.objectContaining({ jobId: id })] });
  }, 180_000);

  it("rejects an unknown flag with the usage", () => {
    const result = run(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ghost:check");
  }, 60_000);
});
