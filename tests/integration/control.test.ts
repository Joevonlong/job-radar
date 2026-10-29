import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { defaultRegistry } from "@/lib/channels/registry";
import { registerControlHandler, resetControlHandlers, processNextControlRequest, runControlPoller } from "@/lib/control";
import { requestRescoreStale, requestRunCycle } from "@/lib/control/service";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { withCycleLock } from "@/lib/cycle/lock";
import { startWaitingForLock } from "@/lib/cycle/lock-waiters";
import { resetCycleSteps } from "@/lib/cycle/steps";
import {
  claimNextControlRequest,
  closeDb,
  countStaleScores,
  createCycle,
  findOpenControlRequest,
  finishCycle,
  getControlRequest,
  getDb,
  insertControlRequest,
  listControlRequests,
  listRunsForCycle,
  requeueInterruptedControlRequests,
  schema,
} from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { resetMarketCache } from "@/lib/market";
import { loadBaseCurrency } from "@/lib/signals/floor";

import { quietLogger } from "../cycle/helpers";
import { makeTempConfig, sleep, type TempConfig } from "../config/helpers";

/** A migration step that throws (a bug, not a ConfigError) for preferences.yaml while `brokenMigration.on` is set. */
const brokenMigration = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/config/migrations/version", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config/migrations/version")>();
  return {
    ...original,
    migrateConfigDocument: (...args: Parameters<typeof original.migrateConfigDocument>) => {
      if (brokenMigration.on && args[0] === "preferences") throw new TypeError("migration step bug");
      return original.migrateConfigDocument(...args);
    },
  };
});

const url = inject("testDatabaseUrl");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table control_requests, scores, jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);
});

afterEach(() => {
  temp.cleanup();
  resetControlHandlers();
  resetCycleSteps();
  defaultRegistry.unregister("fixture");
});

afterAll(async () => {
  await closeDb();
});

/** Check `condition` every 100 ms for up to 5 s. */
async function until(condition: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(100);
  }
  return condition();
}

function pollOptions(signal: AbortSignal = new AbortController().signal) {
  return { db: getDb(), signal, logger: quietLogger };
}

describe("control_requests", () => {
  it("stores a request as pending with its payload", async () => {
    const row = await insertControlRequest(getDb(), { kind: "run_cycle", payload: { channelIds: ["indeed"] } });
    expect(row).toMatchObject({ kind: "run_cycle", status: "pending", payload: { channelIds: ["indeed"] }, startedAt: null, finishedAt: null, result: null });
    expect((await findOpenControlRequest(getDb(), "run_cycle"))?.id).toBe(row.id);
    expect(await findOpenControlRequest(getDb(), "rescore_stale")).toBeNull();
  });

  it("hands each pending request to exactly one claimer, oldest first", async () => {
    const db = getDb();
    const first = await insertControlRequest(db, { kind: "run_cycle" });
    const second = await insertControlRequest(db, { kind: "rescore_stale" });
    const claimed = await Promise.all([claimNextControlRequest(db), claimNextControlRequest(db), claimNextControlRequest(db)]);
    const ids = claimed.flatMap((r) => (r ? [r.id] : [])).sort();
    expect(ids).toEqual([first.id, second.id]);
    expect(claimed.filter((r) => r === null)).toHaveLength(1);
    expect((await getControlRequest(db, first.id))?.status).toBe("running");
    expect((await getControlRequest(db, first.id))?.startedAt).toBeInstanceOf(Date);
    expect(await claimNextControlRequest(db)).toBeNull();
  });

  it("queues again what a dead runner left running, and fails it with maxRequeues 0", async () => {
    const db = getDb();
    const row = await insertControlRequest(db, { kind: "rescore_stale" });
    await claimNextControlRequest(db);
    expect(await requeueInterruptedControlRequests(db, { reason: "runner restarted", maxRequeues: 3 })).toEqual({ requeued: 1, failed: 0 });
    expect(await getControlRequest(db, row.id)).toMatchObject({ status: "pending", startedAt: null, result: { interruptions: 1, interrupted: "runner restarted" } });
    expect(await requeueInterruptedControlRequests(db, { reason: "again", maxRequeues: 3 })).toEqual({ requeued: 0, failed: 0 });
    expect((await claimNextControlRequest(db))?.id).toBe(row.id);
    expect(await requeueInterruptedControlRequests(db, { reason: "runner restarted", maxRequeues: 0 })).toEqual({ requeued: 0, failed: 1 });
    expect(await getControlRequest(db, row.id)).toMatchObject({ status: "failed", result: { error: "runner restarted", interruptions: 1 } });
  });

  it.each(["test_telegram", "run_cycle", "salary_lookup"] as const)("never queues a %s request again", async (kind) => {
    const db = getDb();
    const row = await insertControlRequest(db, { kind });
    await claimNextControlRequest(db);
    expect(await requeueInterruptedControlRequests(db, { reason: "runner restarted", maxRequeues: 3 })).toEqual({ requeued: 0, failed: 1 });
    expect(await getControlRequest(db, row.id)).toMatchObject({ status: "failed", result: { error: "runner restarted", interruptions: 0 } });
  });
});

describe("processNextControlRequest", () => {
  it("returns null when nothing is pending", async () => {
    expect(await processNextControlRequest(pollOptions())).toBeNull();
  });

  it("runs the handler of the request kind and records its outcome", async () => {
    const seen: unknown[] = [];
    registerControlHandler("rescore_stale", async (request) => {
      seen.push(request.payload);
      return { status: "done", result: { rescored: 3 } };
    });
    const row = await insertControlRequest(getDb(), { kind: "rescore_stale" });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ id: row.id, status: "done", result: { rescored: 3 } });
    expect(finished?.finishedAt).toBeInstanceOf(Date);
    expect(seen).toEqual([{}]);
  });

  it("a request interrupted by the abort is queued again; a genuine failure during shutdown is not", async () => {
    const abort = new AbortController();
    const options = { ...pollOptions(abort.signal), maxRequeues: () => 3 };
    registerControlHandler("rescore_stale", async () => {
      abort.abort();
      return { status: "failed", result: { error: "aborted" } };
    });
    const interrupted = await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(options)).toMatchObject({ id: interrupted.id, status: "pending" });

    registerControlHandler("rescore_stale", async () => ({ status: "failed", result: { error: "invalid_payload" } }));
    expect(await processNextControlRequest(options)).toMatchObject({ id: interrupted.id, status: "failed", result: { error: "invalid_payload" } });

    registerControlHandler("rescore_stale", async () => {
      throw new Error("quota exceeded");
    });
    const genuine = await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(options)).toMatchObject({ id: genuine.id, status: "failed", result: { error: "handler_error" } });

    registerControlHandler("rescore_stale", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const thrownAbort = await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(options)).toMatchObject({ id: thrownAbort.id, status: "pending" });
  });

  it("a handler that throws fails the request and nothing else", async () => {
    registerControlHandler("rescore_stale", async () => {
      throw new Error("boom");
    });
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "failed", result: { error: "handler_error", detail: "Error: boom" } });
  });

  it("runs each request with the config files as they are now (a market saved by the web since the last one)", async () => {
    fs.mkdirSync(temp.profileDir, { recursive: true });
    const file = path.join(temp.profileDir, "preferences.yaml");
    const template = fs.readFileSync(path.join(temp.defaultsDir, "profile.example", "preferences.yaml"), "utf8");
    const save = (market: string) => fs.writeFileSync(file, template.replace(/market:\n(?:  .*\n)+/, market));
    resetMarketCache();
    try {
      save("market:\n  pack: generic\n  country: US\n  currency: USD\n  home_language: en\n");
      expect(loadBaseCurrency()).toBe("USD"); // this process has the US market cached
      const seen: Array<string | null> = [];
      registerControlHandler("rescore_stale", async () => {
        seen.push(loadBaseCurrency());
        return { status: "done", result: {} };
      });
      save("market:\n  pack: de\n  country: DE\n  currency: EUR\n  home_language: de\n"); // another process, no watcher
      await insertControlRequest(getDb(), { kind: "rescore_stale" });
      await processNextControlRequest(pollOptions());
      expect(seen).toEqual(["EUR"]);
    } finally {
      resetMarketCache();
    }
  });

  it("a config that cannot be reloaded (a migration throws) keeps its last good value; the request still finishes", async () => {
    fs.mkdirSync(temp.profileDir, { recursive: true });
    const file = path.join(temp.profileDir, "preferences.yaml");
    const template = fs.readFileSync(path.join(temp.defaultsDir, "profile.example", "preferences.yaml"), "utf8");
    const save = (market: string) => fs.writeFileSync(file, template.replace(/market:\n(?:  .*\n)+/, market));
    resetMarketCache();
    try {
      save("market:\n  pack: generic\n  country: US\n  currency: USD\n  home_language: en\n");
      expect(loadBaseCurrency()).toBe("USD");
      const seen: Array<string | null> = [];
      registerControlHandler("rescore_stale", async () => {
        seen.push(loadBaseCurrency());
        return { status: "done", result: {} };
      });
      save("market:\n  pack: de\n  country: DE\n  currency: EUR\n  home_language: de\n");
      brokenMigration.on = true;
      await insertControlRequest(getDb(), { kind: "rescore_stale" });
      const finished = await processNextControlRequest(pollOptions());
      expect(finished?.status).toBe("done"); // not left `running`
      expect(seen).toEqual(["USD"]); // the last good value
    } finally {
      brokenMigration.on = false;
      resetMarketCache();
    }
  });

  it("the placeholder re-score handler acknowledges the request without claiming to have scored anything", async () => {
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "done", result: { scored: 0, failed: 0, placeholder: true } });
  });

  it.each([false, true])("run_cycle reports its id and isolates maintenance failures (throws=%s)", async (throws) => {
    registerFixtureChannel(defaultRegistry, { postings: [] });
    const row = await insertControlRequest(getDb(), { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
    const onCycleFinished = vi.fn(() => { if (throws) throw new Error("private maintenance error"); });
    const finished = await processNextControlRequest({ ...pollOptions(), onCycleFinished });
    expect(finished?.id).toBe(row.id);
    expect(finished).toMatchObject({ status: "done", result: { cycleStatus: "succeeded" } });
    const cycleId = (finished?.result as { cycleId: number }).cycleId;
    const [cycle] = await getDb().select().from(schema.cycles);
    expect(cycle).toMatchObject({ id: cycleId, kind: "manual", status: "succeeded" });
    const runs = await listRunsForCycle(getDb(), cycleId);
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs.map((r) => r.channelId))).toEqual(new Set(["fixture"]));
    expect(onCycleFinished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      dryRun: false, steps: expect.arrayContaining([expect.objectContaining({ name: "collect", status: "ok" })]),
    }));
  });

  /** Another process holds the cycle lock with a cycle limited to `channelIds` (null: every channel) while `fn` runs. */
  async function holdLock(channelIds: string[] | null, fn: (id: number) => Promise<void>) {
    const db = getDb();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let id = 0;
    const held = withCycleLock(db, "try", async (holder) => {
      const row = await createCycle(db, { kind: channelIds === null ? "weekday_morning" : "manual", summary: { channelIds, lockPid: holder.pid } });
      id = row.id;
      await gate;
      await finishCycle(db, row.id, { status: "succeeded" });
    });
    try {
      const deadline = Date.now() + 5000;
      while (id === 0 && Date.now() < deadline) await sleep(20);
      expect(id).toBeGreaterThan(0); // a lock leaked by an earlier test would leave it at 0
      await fn(id);
    } finally {
      release();
      expect((await held).acquired).toBe(true);
    }
  }

  it("run_cycle is done, pointing at the running cycle, when that cycle covers it; one of other channels fails it", async () => {
    registerFixtureChannel(defaultRegistry, { postings: [] });
    const db = getDb();
    await holdLock(null, async (id) => {
      const covered = await insertControlRequest(db, { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
      expect(await processNextControlRequest(pollOptions())).toMatchObject({ id: covered.id, status: "done", result: { cycleId: id, coveredBy: id } });
    });

    // a running cycle limited to other channels does not cover the request: it fails as before (a manual request never waits)
    await holdLock(["indeed"], async () => {
      await insertControlRequest(db, { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
      expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "another_cycle_running" } });
    });
  });

  it("run_cycle is not covered by a row a crash left `running`, only by the cycle that holds the lock", async () => {
    registerFixtureChannel(defaultRegistry, { postings: [] });
    const db = getDb();
    // an interrupted CLI cycle of every channel, newer than nothing that holds the lock
    await db.insert(schema.cycles).values({ kind: "manual", status: "running", summaryJson: { channelIds: null } });
    await holdLock(["indeed"], async () => {
      await insertControlRequest(db, { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
      expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "another_cycle_running" } });
    });
  });

  it("claims no run_cycle while a cycle of this process waits for the lock; other requests still run", async () => {
    const db = getDb();
    const cycleRequest = await insertControlRequest(db, { kind: "run_cycle", payload: { channelIds: ["indeed"] } });
    const rescore = await insertControlRequest(db, { kind: "rescore_stale" });
    const stopWaiting = startWaitingForLock();
    try {
      expect(await processNextControlRequest(pollOptions())).toMatchObject({ id: rescore.id, status: "done" });
      expect(await processNextControlRequest(pollOptions())).toBeNull();
    } finally {
      stopWaiting();
    }
    expect((await getControlRequest(db, cycleRequest.id))?.status).toBe("pending");
  });

  it("run_cycle with a payload it does not understand fails without running anything", async () => {
    await insertControlRequest(getDb(), { kind: "run_cycle", payload: { channelIds: "indeed" } });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "invalid_payload" } });
    expect(await getDb().select().from(schema.cycles)).toHaveLength(0);
  });
});

describe("runControlPoller", () => {
  it("picks up requests while it runs and stops when aborted", async () => {
    const abort = new AbortController();
    const done = runControlPoller({ ...pollOptions(abort.signal), pollSeconds: () => 1 });
    const row = await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await until(async () => (await getControlRequest(getDb(), row.id))?.status === "done")).toBe(true);
    abort.abort();
    await done;
  });
});

describe("web side: requestRunCycle / requestRescoreStale", () => {
  it("creates one request and reuses it while it is open", async () => {
    const first = await requestRunCycle({});
    expect(first).toMatchObject({ status: "queued", kind: "run_cycle", existing: false });
    const again = await requestRunCycle({ channelIds: ["indeed"] });
    expect(again).toMatchObject({ status: "queued", existing: true });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(1);
    await processNextControlRequest(pollOptions());
    expect(await requestRunCycle({})).toMatchObject({ status: "queued", existing: false });
  });

  it("reuses an open request only when it covers the new one; otherwise queues a second one", async () => {
    // [indeed] open, then [greenhouse]: a request of its own
    expect(await requestRunCycle({ channelIds: ["indeed"] })).toMatchObject({ status: "queued", existing: false });
    expect(await requestRunCycle({ channelIds: ["greenhouse"] })).toMatchObject({ status: "queued", existing: false });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(2);
    // [indeed] open, then every channel: a request of its own
    expect(await requestRunCycle({})).toMatchObject({ status: "queued", existing: false });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(3);
    // every channel open: anything reuses it
    expect(await requestRunCycle({ channelIds: ["lever"] })).toMatchObject({ status: "queued", existing: true });
    expect(await requestRunCycle({})).toMatchObject({ status: "queued", existing: true });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(3);
  });

  it("reuses an open request of more channels for a subset of them", async () => {
    const first = await requestRunCycle({ channelIds: ["indeed", "greenhouse"] });
    expect(first).toMatchObject({ status: "queued", existing: false });
    expect(await requestRunCycle({ channelIds: ["greenhouse"] })).toMatchObject({ status: "queued", existing: true, request: first.status === "queued" ? first.request : -1 });
    expect(await requestRunCycle({ channelIds: ["greenhouse", "lever"] })).toMatchObject({ status: "queued", existing: false });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(2);
  });

  it("does not reuse a request of every channel for a later source of the LinkedIn cascade", async () => {
    // the test's own cascade: guest first, session as its fallback
    const file = path.join(temp.configDir, "sources.yaml");
    const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
    doc.setIn(["linkedin", "cascade"], ["linkedin-guest", "linkedin-session"]);
    fs.writeFileSync(file, doc.toString());
    resetConfigCache();
    const [first, later] = ["linkedin-guest", "linkedin-session"];
    expect(loadConfig("channels").linkedin.cascade).toEqual([first, later]);
    expect(await requestRunCycle({})).toMatchObject({ status: "queued", existing: false });
    // a full cycle collects LinkedIn with the first source only
    expect(await requestRunCycle({ channelIds: [later] })).toMatchObject({ status: "queued", existing: false });
    expect(await requestRunCycle({ channelIds: [first] })).toMatchObject({ status: "queued", existing: true });
    // the request of the later source covers a second click on it
    expect(await requestRunCycle({ channelIds: [later] })).toMatchObject({ status: "queued", existing: true });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(2);
  });

  it("validates the payload and the channel ids", async () => {
    expect(await requestRunCycle({ channelIds: [] })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestRunCycle({ channelIds: ["indeed", 5] })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestRunCycle({ surprise: true })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestRunCycle({ channelIds: ["not-a-channel"] })).toMatchObject({ status: "error", error: "unknownChannel" });
    expect(await requestRunCycle({ channelIds: ["indeed", "linkedin-guest"] })).toMatchObject({ status: "queued" });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(1);
  });

  it("re-scoring needs stale scores", async () => {
    expect(await requestRescoreStale()).toMatchObject({ status: "error", error: "nothingStale" });
    const db = getDb();
    const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: "acme" }).returning();
    const [job] = await db.insert(schema.jobs).values({ companyId: company?.id ?? 0, title: "AI Engineer", titleNorm: "ai engineer" }).returning();
    await db.insert(schema.scores).values({ jobId: job?.id ?? 0, filterResult: "passed", score: 70, stale: true });
    expect(await countStaleScores(db)).toBe(1);
    expect(await requestRescoreStale()).toMatchObject({ status: "queued", kind: "rescore_stale", existing: false });
    expect(await requestRescoreStale()).toMatchObject({ status: "queued", existing: true });
  });
});
