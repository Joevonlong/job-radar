import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createHttpClient, type FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { upsertChannelRows } from "@/lib/db/repos/channels";
import { markJobsPossiblyClosed } from "@/lib/db/repos/jobs";
import { runMaintenance } from "@/lib/pipeline";

import { config, pinnedSearch, quietLogger } from "../cycle/helpers";
import { pipelineWith } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-11-01T10:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const CLOSED_AFTER = 7;
const UNSEEN_AFTER = 14;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);
});
afterAll(async () => { await closeDb(); });
afterEach(() => { resetCycleSteps(); });

async function addJob(title: string, channelIds: readonly string[], seenDaysAgo = 10) {
  const db = getDb();
  await upsertChannelRows(db, channelIds.map((id) => ({ id, family: "google", kind: "api", enabled: true })));
  const [company] = await db.insert(schema.companies).values({ name: title, nameNorm: title.toLowerCase() }).returning();
  const [job] = await db.insert(schema.jobs).values({
    companyId: company!.id, title, titleNorm: title.toLowerCase(), status: "active",
    firstSeenAt: at(-30), lastSeenAt: at(-seenDaysAgo),
  }).returning();
  for (const channelId of channelIds) {
    const [raw] = await db.insert(schema.rawPostings).values({
      channelId, externalId: title, payloadJson: { title }, fetchedAt: at(-seenDaysAgo),
    }).returning();
    await db.insert(schema.jobSources).values({
      jobId: job!.id, rawPostingId: raw!.id, channelId, url: `https://jobs.example.test/${encodeURIComponent(title)}`,
    });
  }
  return job!;
}

const mark = () => markJobsPossiblyClosed(getDb(), { now: NOW, days: CLOSED_AFTER });
const readJob = async (id: number) => (await getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;

async function successfulRun(channelId: string, extended: boolean) {
  const [run] = await getDb().insert(schema.runs).values({
    channelId, queryHash: "example-query", status: "succeeded", fetched: 1, newCount: 1,
    startedAt: at(-1), finishedAt: at(-1), windowHours: extended ? 168 : 24, windowExtended: extended,
  }).returning();
  // Another posting filled the result cap; the active job's raw posting was not returned again.
  await getDb().insert(schema.rawPostings).values({
    channelId, externalId: "other-posting", runId: run!.id, fetchedAt: at(-1),
    payloadJson: { title: "Older posting returned by the search", posted_at: at(-5).toISOString() },
  });
}

describe("absence evidence from search windows", () => {
  it.each([36, 12])("marks a subset with a %s-hour backfill of the same returned postings and reopens a returned job", async (backfillHours) => {
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, {
      postings: [{ id: "Returned posting", title: "Returned posting", company: "Example Labs", city: null, country: null, remote: false, description: "Build software", url: null, posted_at: null }],
    });
    const missing = await addJob("Missing posting", [fixture.id]);
    const returned = await addJob("Returned posting", [fixture.id]);
    const cfg = config({ search: {
      ...pinnedSearch(), keyword_groups: { engineering: ["Platform Engineer"] }, locations: ["Test City"],
      remote_scope: "none", window_hours: { morning: 24, evening: 24, weekend: 24 },
    } });
    cfg.channels.collect.max_catch_up_hours = 0;
    const maintenanceConfig = pipelineWith((raw) => {
      Object.assign(raw.lifecycle as Record<string, unknown>, {
        possibly_closed_after_days: CLOSED_AFTER, unseen_link_check_after_days: 0,
        max_link_checks_per_cycle: 0, dormant_after_days: 0,
      });
    });
    const fetch: FetchLike = async () => { throw new Error("unexpected link check"); };
    const replay = async (hours?: number) => {
      // Replay the same starting sightings and status; remove the earlier cycle's absence evidence.
      await getDb().delete(schema.runs);
      await getDb().update(schema.rawPostings).set({ fetchedAt: at(-10) });
      await getDb().update(schema.jobs).set({ status: "active", lastSeenAt: at(-10), possiblyClosedAt: null });
      await getDb().update(schema.jobs).set({ status: "possibly_closed" }).where(eq(schema.jobs.id, returned.id));
      const cycle = await runCycle("manual", {
        registry, cascades: [], config: cfg, logger: quietLogger, now: () => NOW, sleep: async () => {}, fetch,
        ...(hours === undefined ? {} : { backfillHours: hours }),
      });
      expect(cycle.status).toBe("succeeded");
      // Runs and raw postings use SQL defaults: align them with the scenario clock before maintenance.
      await getDb().update(schema.runs).set({ startedAt: NOW }).where(eq(schema.runs.cycleId, cycle.cycleId!));
      const [run] = await getDb().select().from(schema.runs).where(eq(schema.runs.cycleId, cycle.cycleId!));
      expect(run).toMatchObject({ status: "succeeded", windowHours: Math.max(24, hours ?? 0), windowExtended: (hours ?? 0) > 24 });
      await getDb().update(schema.rawPostings).set({ fetchedAt: NOW }).where(eq(schema.rawPostings.runId, run!.id));
      const result = await runMaintenance(getDb(), { relist: { minGapDays: 9 },
        config: maintenanceConfig, logger: quietLogger, now: () => NOW,
        http: createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch }),
      });
      expect(result.reopened).toBe(1);
      expect(await readJob(returned.id)).toMatchObject({ status: "active", lastSeenAt: NOW });
      return (await getDb().select().from(schema.jobs).where(eq(schema.jobs.status, "possibly_closed"))).map((job) => job.id);
    };
    const plain = await replay();
    const backfill = await replay(backfillHours);
    expect(plain).toEqual([missing.id]);
    expect(backfill.every((id) => plain.includes(id))).toBe(true);
    expect(backfill).toEqual(backfillHours > 24 ? [] : plain);
    expect(fixture.seen.map((query) => query.windowHours)).toEqual([24, Math.max(24, backfillHours)]);
  });

  it.each([true, false])("marks an unseen job only when the later successful run is not extended (extended=%s)", async (extended) => {
    const job = await addJob("Still recruiting", ["search-fixture"]);
    expect(job.lastSeenAt.getTime()).toBeLessThan(at(-CLOSED_AFTER).getTime());
    expect(job.lastSeenAt.getTime()).toBeGreaterThan(at(-UNSEEN_AFTER).getTime());
    await successfulRun("search-fixture", extended);
    expect(await mark()).toEqual(extended ? [] : [job.id]);
    expect(await readJob(job.id)).toMatchObject({ status: extended ? "active" : "possibly_closed", lastSeenAt: job.lastSeenAt });
  });

  it.each([7, 42, 901])("marks a subset when the same seeded run set contains extended windows (seed %s)", async (seed) => {
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const channelIds = ["regular", "extended", "failed", "mixed"];
    await upsertChannelRows(getDb(), channelIds.map((id) => ({ id, family: "google", kind: "api", enabled: true })));
    const statuses = ["succeeded", "failed", "skipped", "partial"] as const;
    await getDb().insert(schema.runs).values([
      { channelId: "regular", status: "succeeded", startedAt: at(-1), windowHours: 24, windowExtended: false },
      { channelId: "extended", status: "succeeded", startedAt: at(-1), windowHours: 168, windowExtended: true },
      { channelId: "failed", status: "failed", startedAt: at(-1), windowHours: 168, windowExtended: true },
      ...Array.from({ length: 5 }, () => ({
        channelId: "mixed", status: statuses[Math.floor(random() * statuses.length)]!,
        startedAt: at(-(1 + Math.floor(random() * 20))), windowHours: 168, windowExtended: random() < 0.5,
      })),
    ]);
    const regular = await addJob("Regular evidence control", ["regular"]);
    const extendedOnly = await addJob("Extended evidence control", ["extended"]);
    for (let index = 0; index < 12; index += 1) {
      const sources = channelIds.filter(() => random() < 0.5);
      await addJob(`Generated job ${index}`, sources.length ? sources : [channelIds[index % channelIds.length]!], 1 + Math.floor(random() * 25));
    }
    const markedWithExtended = new Set(await mark());
    expect(markedWithExtended.has(regular.id)).toBe(true);
    expect(markedWithExtended.has(extendedOnly.id)).toBe(false);

    // Replay exactly the same jobs and sightings with only the run flags changed.
    await getDb().update(schema.jobs).set({ status: "active", possiblyClosedAt: null });
    await getDb().update(schema.runs).set({ windowExtended: false });
    const markedWithoutExtended = new Set(await mark());
    expect(markedWithoutExtended.has(extendedOnly.id)).toBe(true);
    expect([...markedWithExtended].every((id) => markedWithoutExtended.has(id))).toBe(true);
    expect(markedWithoutExtended.size).toBeGreaterThan(markedWithExtended.size);
  });

  it.each([404, 200])("checks the unseen active job through maintenance despite having only extended runs (HTTP %s)", async (status) => {
    const job = await addJob("Unseen recruiting job", ["search-fixture"], 20);
    await successfulRun("search-fixture", true);
    expect(await mark()).toEqual([]);
    expect((await readJob(job.id)).status).toBe("active");
    const calls: Array<{ method: string; url: string }> = [];
    const fetch: FetchLike = async (requestUrl, init) => {
      calls.push({ method: init.method ?? "GET", url: requestUrl });
      return { status, ok: status === 200, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
    };
    const result = await runMaintenance(getDb(), { relist: { minGapDays: 9 },
      config: pipelineWith((raw) => {
        Object.assign(raw.lifecycle as Record<string, unknown>, {
          possibly_closed_after_days: CLOSED_AFTER, unseen_link_check_after_days: UNSEEN_AFTER,
          unseen_link_check_interval_days: 7, max_link_checks_per_cycle: 5, dormant_after_days: 0,
        });
      }),
      http: createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch }),
      logger: quietLogger, now: () => NOW, resolveHost: async () => ["93.184.216.34"],
    });
    const expectedUrl = "https://jobs.example.test/Unseen%20recruiting%20job";
    expect(calls).toEqual(status === 404
      ? [{ method: "HEAD", url: expectedUrl }, { method: "GET", url: expectedUrl }]
      : [{ method: "HEAD", url: expectedUrl }]);
    expect(result).toMatchObject({
      possiblyClosed: 0, linkChecked: 1, closed: status === 404 ? 1 : 0, alive: status === 200 ? 1 : 0,
      unseen: { checked: 1, closed: status === 404 ? 1 : 0, alive: status === 200 ? 1 : 0 },
    });
    expect(await readJob(job.id)).toMatchObject({
      status: status === 404 ? "closed" : "active", linkCheckedAt: NOW,
      lastSeenAt: status === 200 ? NOW : job.lastSeenAt,
    });
  });
});
