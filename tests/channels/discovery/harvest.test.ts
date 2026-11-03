// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createMemoryDiscoveryStore, harvestBoardLinks, knownBoardKeys, type BoardLink } from "@/lib/channels/discovery";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { companiesSchema } from "@/lib/config";

const NOW = new Date("2026-10-24T09:00:00Z");

const LINKS: BoardLink[] = [
  { url: "https://acme.jobs.personio.de/job/1", label: "Acme GmbH" },
  { url: "https://acme.jobs.personio.de/job/2", label: "Acme (other posting)" },
  { url: "https://jobs.ashbyhq.com/Beta/uuid", label: "Beta" },
  { url: "https://jobs.lever.co/known/uuid", label: "Known" },
  { url: "https://join.com/companies/x/1", label: "Join" },
  { url: "https://linkedin.example/jobs/1", label: null },
  { url: "not a url", label: "Broken" },
  { url: "https://job-boards.greenhouse.io/gamma/jobs/9", label: null },
];

const known = knownBoardKeys(companiesSchema.parse({ companies: [{ name: "Known", ats: "lever", token: "KNOWN", enabled: false }] }));

function setup() {
  const records: LogRecord[] = [];
  return { records, logger: createLogger({ sink: (r) => records.push(r), minLevel: "debug" }), store: createMemoryDiscoveryStore() };
}

describe("knownBoardKeys", () => {
  it("lists every board of ats_boards, enabled or not, lower-cased", () => {
    expect([...known]).toEqual(["lever:known"]);
  });
});

describe("harvestBoardLinks", () => {
  it("keeps official board links once per board, drops known boards, and tags the source", async () => {
    const { store, logger } = setup();
    const result = await harvestBoardLinks({ provider: "agg", links: LINKS, known, store, intervalHours: 24, now: NOW, logger });
    expect(result).toMatchObject({ skipped: null, added: 3 });
    expect(result.candidates.map((c) => `${c.ats}:${c.token}`)).toEqual(["personio:acme", "ashby:Beta", "greenhouse:gamma"]);
    expect(result.candidates.map((c) => c.title)).toEqual(["Acme GmbH", "Beta", null]);
    expect([...store.foundBy.entries()]).toEqual([["personio:acme", ["agg"]], ["ashby:Beta", ["agg"]], ["greenhouse:gamma", ["agg"]]]);
    expect(store.runs).toBe(1);
  });

  it("does nothing while the last run is younger than the interval, and runs again after it", async () => {
    const { store, logger, records } = setup();
    store.last = new Date(NOW.getTime() - 2 * 3_600_000);
    const recent = await harvestBoardLinks({ provider: "agg", links: LINKS, known, store, intervalHours: 24, now: NOW, logger });
    expect(recent).toEqual({ skipped: "recent", candidates: [], added: null });
    expect(store.candidates.size + store.runs).toBe(0);
    expect(records.some((r) => r.message.includes("ran recently"))).toBe(true);
    store.last = new Date(NOW.getTime() - 25 * 3_600_000);
    expect((await harvestBoardLinks({ provider: "agg", links: LINKS, known, store, intervalHours: 24, now: NOW, logger })).skipped).toBeNull();
    expect(store.candidates.size).toBe(3);
  });

  it("a dry run (no store) writes and marks nothing and logs what it found", async () => {
    const { logger, records } = setup();
    const result = await harvestBoardLinks({ provider: "agg", links: LINKS, known, store: null, intervalHours: 24, now: NOW, logger });
    expect(result).toMatchObject({ skipped: null, added: null });
    expect(result.candidates).toHaveLength(3);
    expect(records.find((r) => r.message.includes("dry run"))?.fields).toMatchObject({ links: 8, boards: ["personio:acme", "ashby:Beta", "greenhouse:gamma"] });
  });

  it("a board seen by two sources keeps both, and the count of new ones does not grow", async () => {
    const { store, logger } = setup();
    await harvestBoardLinks({ provider: "b-source", links: LINKS, known, store, intervalHours: 0, now: NOW, logger });
    store.last = null; // the memory store stamps the real clock
    const second = await harvestBoardLinks({ provider: "a-source", links: LINKS, known, store, intervalHours: 0, now: NOW, logger });
    expect(second.added).toBe(0);
    expect(store.foundBy.get("ashby:Beta")).toEqual(["a-source", "b-source"]);
  });

  it("marks no run when writing fails", async () => {
    const { store, logger } = setup();
    store.upsert = async () => {
      throw new Error("down");
    };
    await expect(harvestBoardLinks({ provider: "agg", links: LINKS, known, store, intervalHours: 24, now: NOW, logger })).rejects.toThrow("down");
    expect(store.runs).toBe(0);
  });
});
