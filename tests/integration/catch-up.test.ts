import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { decideCatchUp } from "@/lib/cycle/catch-up";
import { runCycle } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, createCycle, finishCycle, getCycle, getDb, listRawPostingsForChannel, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels restart identity cascade`);
});

afterEach(() => {
  resetCycleSteps();
});

afterAll(async () => {
  await closeDb();
});

/** Every day at minute 0 of each hour, as the morning cycle only: the "one slot per hour" schedule keeps the test independent of the weekday it runs on. */
function hourlySchedule(catchUp = true) {
  const base = config().schedule;
  return {
    ...base,
    catch_up: catchUp,
    cycles: {
      weekday_morning: { cron: "0 * * * *", enabled: true },
      weekday_evening: { ...base.cycles.weekday_evening, enabled: false },
      weekend: { ...base.cycles.weekend, enabled: false },
    },
  };
}

describe("runner start after a day of downtime (catch-up)", () => {
  it("runs exactly one catch-up cycle for the missed slot, collects postings, and is then up to date", async () => {
    const db = getDb();
    const schedule = hourlySchedule();
    const now = new Date();

    // the runner last ran a cycle 25 hours ago, then stopped
    const last = await createCycle(db, { kind: "weekday_morning", startedAt: new Date(now.getTime() - 25 * HOUR) });
    await finishCycle(db, last.id, { status: "succeeded" });

    const decision = await decideCatchUp(db, schedule, now);
    expect(decision.disabled).toBe(false);
    expect(decision.lastCycleStartedAt?.getTime()).toBe(last.startedAt.getTime());
    expect(decision.missed?.kind).toBe("weekday_morning");
    expect(decision.missed?.slot.getTime()).toBeGreaterThan(last.startedAt.getTime());
    expect(decision.missed?.slot.getTime()).toBeLessThanOrEqual(now.getTime());

    // what the runner does with the decision: one `catchup` cycle for the missed window
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { id: "indeed" });
    const result = await runCycle("catchup", {
      registry,
      config: { ...config(), schedule },
      logger: quietLogger,
      windowKind: decision.missed?.kind,
      sleep: async () => {},
    });
    expect(result.status).toBe("succeeded");
    expect(result.summary.windowKind).toBe("weekday_morning");
    expect(fixture.seen.length).toBeGreaterThan(0);
    expect((await getCycle(db, result.cycleId as number))?.kind).toBe("catchup");
    expect((await listRawPostingsForChannel(db, "indeed")).length).toBeGreaterThan(0);

    // a second start straight afterwards must not run again
    expect((await decideCatchUp(db, schedule, new Date())).missed).toBeNull();
    expect(await db.select().from(schema.cycles).where(eq(schema.cycles.kind, "catchup"))).toHaveLength(1);
  });

  it("finds nothing to catch up when a cycle ran after the latest slot", async () => {
    const db = getDb();
    const now = new Date();
    await createCycle(db, { kind: "manual", startedAt: new Date(now.getTime() - 1000) });
    expect((await decideCatchUp(db, hourlySchedule(), now)).missed).toBeNull();
  });

  it("still catches up when the only cycle since the slot was limited to some channels (a manual collect of one channel)", async () => {
    const db = getDb();
    const now = new Date();
    const last = await createCycle(db, { kind: "weekday_morning", startedAt: new Date(now.getTime() - 25 * HOUR) });
    await finishCycle(db, last.id, { status: "succeeded" });
    // what "collect now" on /sources leaves behind: a manual cycle of one channel
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed" });
    const partial = await runCycle("manual", { registry, config: config(), logger: quietLogger, channelIds: ["indeed"], sleep: async () => {} });
    expect(partial.status).toBe("succeeded");

    const decision = await decideCatchUp(db, hourlySchedule(), new Date());
    expect(decision.lastCycleStartedAt?.getTime()).toBe(last.startedAt.getTime());
    expect(decision.missed?.kind).toBe("weekday_morning");
  });

  it("catches up when a cycle limited to some channels is the only one ever", async () => {
    const db = getDb();
    await createCycle(db, { kind: "manual", startedAt: new Date(Date.now() - 1000), summary: { channelIds: ["indeed"] } });
    const decision = await decideCatchUp(db, hourlySchedule(), new Date());
    expect(decision.lastCycleStartedAt).toBeNull();
    expect(decision.missed?.kind).toBe("weekday_morning");
  });

  it("does nothing when catch_up is switched off in schedule.yaml", async () => {
    const db = getDb();
    const decision = await decideCatchUp(db, hourlySchedule(false), new Date());
    expect(decision).toEqual({ missed: null, lastCycleStartedAt: null, disabled: true });
  });

  it("catches up on a brand-new database that has never run a cycle", async () => {
    const decision = await decideCatchUp(getDb(), hourlySchedule(), new Date());
    expect(decision.lastCycleStartedAt).toBeNull();
    expect(decision.missed?.kind).toBe("weekday_morning");
  });

  it("catches up the shipped schedule after a day off: a Wednesday-morning start finds Wednesday's 07:00 slot", async () => {
    const db = getDb();
    const shipped = config().schedule;
    const last = await createCycle(db, { kind: "weekday_evening", startedAt: new Date("2026-10-06T15:00:20Z") }); // Tue 17:00 Berlin
    await finishCycle(db, last.id, { status: "succeeded" });
    // runner back at Wed 2026-10-07 09:15 Berlin (CEST) after being off all night and morning
    const decision = await decideCatchUp(db, shipped, new Date("2026-10-07T07:15:00Z"));
    expect(decision.missed?.kind).toBe("weekday_morning");
    expect(decision.missed?.slot.toISOString()).toBe("2026-10-07T05:00:00.000Z");
  });
});
