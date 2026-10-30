import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { buildDiscoveryQueries, createBraveChannel, createDbDiscoveryStore, type BraveDeps } from "@/lib/channels/discovery";
import { ChannelRegistry } from "@/lib/channels/registry";
import { loadCompanies, reloadConfig, resetConfigCache } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, listBoardCandidates, schema, setBoardCandidateStatus, upsertBoardCandidates } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";
import { addBoardCandidate, dismissBoardCandidate, loadBoardCandidates } from "@/lib/sources/candidates";

import { response } from "../channels/ats/helpers";
import { shippedSearch } from "../channels/helpers";
import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/discovery/brave-search.json"), "utf8")) as unknown;

let configDir = "";

/** The shipped sources.yaml with `ats_boards` cut down to one Lever board (comment kept). */
function sourcesWithOneBoard(): string {
  const shipped = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/defaults/sources.yaml"), "utf8");
  const start = shipped.indexOf("\nats_boards:\n");
  const end = shipped.indexOf("\n\n", start + 1);
  return `${shipped.slice(0, start)}\n# test boards\nats_boards:\n  - { name: Pipewerk, ats: lever, token: pipewerk, enabled: true }${shipped.slice(end)}`;
}
const savedConfigDir = process.env.JOB_RADAR_CONFIG_DIR;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table ats_board_candidates, runtime_state, runs, cycles, channels restart identity cascade`);
  // a sources.yaml of its own (the shipped one with a single board), so adding a board never touches the real file
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-discovery-"));
  fs.writeFileSync(path.join(configDir, "sources.yaml"), sourcesWithOneBoard());
  process.env.JOB_RADAR_CONFIG_DIR = configDir;
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.JOB_RADAR_CONFIG_DIR;
  else process.env.JOB_RADAR_CONFIG_DIR = savedConfigDir;
  resetConfigCache();
});

afterAll(async () => {
  await closeDb();
});

const candidate = (token: string, extra: Partial<Parameters<typeof upsertBoardCandidates>[1][number]> = {}) => ({
  ats: "ashby",
  token,
  region: null,
  boardUrl: `https://jobs.ashbyhq.com/${token}`,
  title: `Jobs at ${token}`,
  ...extra,
});

describe("migration 0010: ats_board_candidates", () => {
  it("is keyed by (ats, token) and only allows the three statuses", async () => {
    await upsertBoardCandidates(getDb(), [candidate("acme")]);
    await expect(getDb().execute(sql`insert into ats_board_candidates (ats, token, board_url, status) values ('ashby', 'x', 'u', 'weird')`)).rejects.toThrow();
    await expect(getDb().execute(sql`insert into ats_board_candidates (ats, token, board_url) values ('ashby', 'acme', 'u')`)).rejects.toThrow();
  });
});

describe("board candidate repo", () => {
  it("counts new boards, keeps the status of a board seen again and refreshes its sighting", async () => {
    const db = getDb();
    expect(await upsertBoardCandidates(db, [candidate("a"), candidate("b")])).toBe(2);
    await setBoardCandidateStatus(db, { ats: "ashby", token: "a" }, "dismissed");

    expect(await upsertBoardCandidates(db, [candidate("a", { title: null }), candidate("b", { title: "New title" }), candidate("c")])).toBe(1);

    const fresh = await listBoardCandidates(db, "new");
    expect(fresh.map((r) => r.token).sort()).toEqual(["b", "c"]);
    expect(fresh.find((r) => r.token === "b")).toMatchObject({ seenCount: 2, title: "New title" });
    const dismissed = await listBoardCandidates(db, "dismissed");
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({ token: "a", seenCount: 2, title: "Jobs at a" }); // a null title never erases a known one
  });

  it("an empty batch is a no-op; an unknown board cannot get a status", async () => {
    expect(await upsertBoardCandidates(getDb(), [])).toBe(0);
    expect(await setBoardCandidateStatus(getDb(), { ats: "ashby", token: "ghost" }, "added")).toBe(false);
  });
});

// Brave is off in the shipped sources.yaml by default (Tavily is the default); this suite tests Brave itself.
function braveEnabledConfig() {
  const base = config();
  const sources = base.channels.sources;
  return { ...base, channels: { ...base.channels, sources: { ...sources, brave: { ...sources.brave, enabled: true, max_queries_per_run: 12 } } } };
}

describe("discovery store turns", () => {
  it("round-trips timestamps to the millisecond and replaces the previous turns", async () => {
    const store = createDbDiscoveryStore(getDb(), "brave");
    const tavily = createDbDiscoveryStore(getDb(), "tavily");
    expect(await store.lastTurns()).toEqual(new Map());
    const first = new Map([["one", new Date("2026-10-01T01:02:03.456Z")], ["two", new Date("2026-10-02T02:03:04.567Z")]]);
    await store.saveTurns(first);
    expect(await store.lastTurns()).toEqual(first);
    expect((await getRuntimeState(getDb(), "discovery:brave:turns"))?.value).toEqual({
      version: 1, turns: Object.fromEntries([...first].map(([id, at]) => [id, at.toISOString()])),
    });
    expect(await tavily.lastTurns()).toEqual(new Map());
    await tavily.saveTurns(first);
    const next = new Map([["two", new Date("2026-10-03T03:04:05.678Z")]]);
    await store.saveTurns(next);
    expect(await store.lastTurns()).toEqual(next);
    expect(await tavily.lastTurns()).toEqual(first);
  });

  it("treats malformed or unsupported stored turns as empty and replaces them on save", async () => {
    const store = createDbDiscoveryStore(getDb(), "brave");
    for (const value of [{ version: 2 }, "x", { version: 1, turns: { one: "not a date" } }, { version: 1, turns: {}, extra: true }]) {
      await setRuntimeState(getDb(), "discovery:brave:turns", value);
      expect(await store.lastTurns()).toEqual(new Map());
    }
    const turns = new Map([["one", new Date("2026-10-01T01:02:03.456Z")]]);
    await store.saveTurns(turns);
    expect(await store.lastTurns()).toEqual(turns);
  });

  it("keeps turns separate from the exact last-run key even when a similar key exists", async () => {
    const db = getDb();
    const store = createDbDiscoveryStore(db, "brave");
    const turns = new Map([["one", new Date("2026-10-01T01:02:03.456Z")]]);
    await store.saveTurns(turns);
    expect(await store.lastRunAt()).toBeNull();
    await store.markRun();
    const last = await store.lastRunAt();
    expect(last).toBeInstanceOf(Date);
    expect(await store.lastTurns()).toEqual(turns);
    await setRuntimeState(db, "discovery:brave:last_run_x", { ok: true });
    await db.execute(sql`update runtime_state set updated_at = now() - interval '25 hours' where key = 'discovery:brave:last_run_x'`);
    expect(await store.lastRunAt()).toEqual(last);
    expect(await store.lastTurns()).toEqual(turns);
  });
});

describe("brave channel with the database store", () => {
  const search = (input: BraveDeps["inputs"] = () => ({ search: shippedSearch(), companies: loadCompanies(), queryRotation: true })) => {
    const calls: string[] = [];
    const deps: BraveDeps = { inputs: input, store: () => createDbDiscoveryStore(getDb(), "brave"), environment: { BRAVE_SEARCH_API_KEY: "test-key-not-real" } };
    const registry = new ChannelRegistry();
    registry.register(createBraveChannel(deps));
    const run = () =>
      runCycle("manual", {
        registry,
        config: braveEnabledConfig(),
        logger: quietLogger,
        sleep: async () => {},
        channelIds: ["brave"],
        fetch: async (requestUrl) => {
          calls.push(requestUrl);
          return response(200, fixture);
        },
      });
    return { run, calls };
  };

  it("runs inside a cycle, writes the candidates, and skips the next cycle within the interval", async () => {
    const { run, calls } = search();
    const first = await run();
    expect(first.status).toBe("succeeded");
    expect(calls).toHaveLength(12);

    const rows = await listBoardCandidates(getDb(), "new");
    expect(rows.map((r) => `${r.ats}:${r.token}`).sort()).toEqual([
      "ashby:examplelabs",
      "greenhouse:delta",
      "lever:gamma",
      "personio:betagmbh",
      "smartrecruiters:EpsilonGroup",
    ]);
    expect(rows.find((r) => r.token === "gamma")).toMatchObject({ region: "eu", boardUrl: "https://jobs.eu.lever.co/gamma" });
    // the run is recorded as a normal run that fetched no postings
    const runs = await getDb().select().from(schema.runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ channelId: "brave", status: "succeeded", fetched: 0 });

    await run();
    expect(calls).toHaveLength(12); // not searched again
    expect(await listBoardCandidates(getDb(), "new")).toHaveLength(5);
  });

  it("rotates discovery searches across due cycles while keeping one run row per cycle", async () => {
    const { run, calls } = search();
    const queries = buildDiscoveryQueries(shippedSearch()).map((q) => q.q);
    const first = await run();
    expect(first.status).toBe("succeeded");
    const firstQueries = calls.map((call) => new URL(call).searchParams.get("q"));
    expect(firstQueries).toEqual(queries.slice(0, 12));
    await getDb().execute(sql`update runtime_state set updated_at = now() - interval '25 hours' where key = 'discovery:brave:last_run'`);
    const second = await run();
    expect(second.status).toBe("succeeded");
    expect(calls).toHaveLength(24);
    const secondQueries = calls.slice(12).map((call) => new URL(call).searchParams.get("q"));
    expect(secondQueries).toEqual(queries.slice(12, 24));
    expect(secondQueries.some((q) => firstQueries.includes(q))).toBe(false);
    const runs = await getDb().select().from(schema.runs).where(eq(schema.runs.channelId, "brave"));
    expect(runs).toHaveLength(2);
    for (const result of [first, second]) {
      const cycleRuns = runs.filter((r) => r.cycleId === result.cycleId);
      expect(cycleRuns).toHaveLength(1);
      expect(cycleRuns[0]).toMatchObject({ status: "succeeded", fetched: 0 });
    }
  });
});

describe("adding a candidate from /sources", () => {
  it("writes the board into sources.yaml ats_boards (keeping the file's comments), enables it and marks the candidate added", async () => {
    await upsertBoardCandidates(getDb(), [candidate("acme-labs"), candidate("euco", { ats: "lever", region: "eu", boardUrl: "https://jobs.eu.lever.co/euco" })]);

    expect(await addBoardCandidate({ ats: "ashby", token: "acme-labs" })).toEqual({ status: "done", outcome: "added" });
    expect(await addBoardCandidate({ ats: "lever", token: "euco" })).toEqual({ status: "done", outcome: "added" });

    const text = fs.readFileSync(path.join(configDir, "sources.yaml"), "utf8");
    expect(text).toContain("# test boards");
    expect(text).toContain("# 采集通道");
    const companies = reloadConfig("channels").ats_boards;
    expect(companies.map((c) => [c.name, c.ats, c.token, c.enabled, c.region])).toEqual([
      ["Pipewerk", "lever", "pipewerk", true, undefined],
      ["Acme Labs", "ashby", "acme-labs", true, undefined],
      ["Euco", "lever", "euco", true, "eu"],
    ]);
    expect(await listBoardCandidates(getDb(), "new")).toEqual([]);
    expect((await listBoardCandidates(getDb(), "added")).map((r) => r.token).sort()).toEqual(["acme-labs", "euco"]);
  });

  it("does not add twice: a board that is already listed is only marked added", async () => {
    await upsertBoardCandidates(getDb(), [candidate("pipewerk", { ats: "lever" })]);
    expect(await addBoardCandidate({ ats: "lever", token: "pipewerk" })).toEqual({ status: "done", outcome: "already_listed" });
    expect(reloadConfig("channels").ats_boards).toHaveLength(1);
    expect(await listBoardCandidates(getDb(), "added")).toHaveLength(1);
  });

  it("refuses bad input, unknown boards and a sources.yaml that is broken, and writes nothing", async () => {
    await upsertBoardCandidates(getDb(), [candidate("acme")]);
    expect(await addBoardCandidate({ ats: "workday", token: "acme" })).toEqual({ status: "error", error: "invalid" });
    expect(await addBoardCandidate({ ats: "ashby", token: "ghost" })).toEqual({ status: "error", error: "unknown_candidate" });
    fs.writeFileSync(path.join(configDir, "sources.yaml"), "ats_boards: nope\n");
    expect(await addBoardCandidate({ ats: "ashby", token: "acme" })).toEqual({ status: "error", error: "config_invalid" });
    expect(fs.readFileSync(path.join(configDir, "sources.yaml"), "utf8")).toBe("ats_boards: nope\n");
    expect(await listBoardCandidates(getDb(), "new")).toHaveLength(1);
  });

  it("dismiss hides a candidate for good", async () => {
    await upsertBoardCandidates(getDb(), [candidate("acme")]);
    expect(await dismissBoardCandidate({ ats: "ashby", token: "acme" })).toEqual({ status: "done", outcome: "dismissed" });
    expect(await dismissBoardCandidate({ ats: "ashby", token: "acme-ghost" })).toEqual({ status: "error", error: "unknown_candidate" });
    expect(await loadBoardCandidates()).toEqual([]);
    await upsertBoardCandidates(getDb(), [candidate("acme")]); // found again by a later search
    expect(await loadBoardCandidates()).toEqual([]);
  });

  it("loadBoardCandidates lists the waiting boards that sources.yaml does not list", async () => {
    await upsertBoardCandidates(getDb(), [candidate("acme"), candidate("pipewerk", { ats: "lever" })]);
    const views = await loadBoardCandidates();
    expect(views?.map((v) => v.token)).toEqual(["acme"]);
  });
});
