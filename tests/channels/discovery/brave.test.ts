// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  boardFromUrl,
  boardsFromResults,
  buildDiscoveryQueries,
  buildDiscoveryQuery,
  createBraveChannel,
  createMemoryDiscoveryStore,
  type BraveDeps,
} from "@/lib/channels/discovery";
import { configRegistry, companiesSchema } from "@/lib/config";

import { atsContext, response, routedFetch } from "../ats/helpers";
import { shippedSearch } from "../helpers";
import { shippedYaml } from "../../config/helpers";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../fixtures/discovery/brave-search.json"), "utf8")) as unknown;

const companies = companiesSchema.parse({
  companies: [{ name: "Pipewerk", ats: "lever", token: "pipewerk", enabled: true }],
});

function deps(overrides: Partial<BraveDeps> = {}) {
  const store = createMemoryDiscoveryStore();
  const value: BraveDeps = {
    inputs: () => ({ search: shippedSearch(), companies }),
    store: () => store,
    environment: { BRAVE_SEARCH_API_KEY: "test-key-not-real" },
    ...overrides,
  };
  return { deps: value, store };
}

describe("boardFromUrl", () => {
  it("accepts the official hosts of the five ATS and returns the board token", () => {
    expect(boardFromUrl("https://boards.greenhouse.io/acme/jobs/1")).toEqual({ ats: "greenhouse", token: "acme", region: null });
    expect(boardFromUrl("https://job-boards.greenhouse.io/acme")).toMatchObject({ ats: "greenhouse", token: "acme" });
    expect(boardFromUrl("https://job-boards.eu.greenhouse.io/acme")).toMatchObject({ ats: "greenhouse", token: "acme" });
    expect(boardFromUrl("https://jobs.lever.co/acme/uuid")).toEqual({ ats: "lever", token: "acme", region: null });
    expect(boardFromUrl("https://jobs.eu.lever.co/acme")).toEqual({ ats: "lever", token: "acme", region: "eu" });
    expect(boardFromUrl("https://jobs.ashbyhq.com/Acme-Labs/id")).toEqual({ ats: "ashby", token: "Acme-Labs", region: null });
    expect(boardFromUrl("https://acme.jobs.personio.de/job/9?language=de")).toEqual({ ats: "personio", token: "acme", region: null });
    expect(boardFromUrl("https://jobs.smartrecruiters.com/AcmeGroup/744-title")).toEqual({ ats: "smartrecruiters", token: "AcmeGroup", region: null });
    expect(boardFromUrl("https://careers.smartrecruiters.com/AcmeGroup")).toMatchObject({ token: "AcmeGroup" });
    expect(boardFromUrl("https://jobs.smartrecruiters.com/oneclick-ui/company/AcmeGroup/publication/x")).toMatchObject({ token: "AcmeGroup" });
  });

  it("rejects other hosts, look-alikes, reserved paths and nested sub-domains", () => {
    for (const url of [
      "https://jobs.lever.co.evil.example/acme/1",
      "https://evil.example/jobs.lever.co/acme",
      "https://lever.co/acme",
      "https://boards.greenhouse.io/embed/job_app?token=1",
      "https://boards.greenhouse.io/",
      "https://www.jobs.personio.de/job/1",
      "https://a.b.jobs.personio.de/job/1",
      "https://jobs.personio.de/job/1",
      "ftp://jobs.lever.co/acme",
      "javascript:alert(1)",
      "not a url",
      "https://jobs.lever.co/%E0%A4%A",
      "https://jobs.lever.co/-bad",
    ]) {
      expect(boardFromUrl(url), url).toBeNull();
    }
  });
});

describe("discovery queries", () => {
  it("builds one query per ATS x keyword group x city from search.yaml", () => {
    const queries = buildDiscoveryQueries(shippedSearch());
    expect(queries).toHaveLength(5 * 3 * 2);
    expect(queries.map((q) => q.ats)).toEqual(expect.arrayContaining(["greenhouse", "lever", "ashby", "personio", "smartrecruiters"]));
    const german = queries.find((q) => q.group === "german" && q.ats === "lever" && q.city === "München");
    expect(german?.q).toBe('(site:jobs.lever.co OR site:jobs.eu.lever.co) ("KI Engineer" OR "KI-Entwickler") "München"');
    expect(queries.find((q) => q.ats === "personio")?.q.startsWith("site:jobs.personio.de (")).toBe(true);
  });

  it("keeps a query within Brave's limits by dropping the keywords that do not fit", () => {
    const many = Array.from({ length: 80 }, (_, i) => `Keyword Number ${i}`);
    const q = buildDiscoveryQuery("greenhouse", many, "Berlin");
    expect(q).not.toBeNull();
    expect((q ?? "").length).toBeLessThanOrEqual(400);
    expect((q ?? "").split(/\s+/).length).toBeLessThanOrEqual(50);
    expect(q).toContain('"Keyword Number 0"');
    expect(buildDiscoveryQuery("ashby", [], "Berlin")).toBeNull();
    expect(buildDiscoveryQuery("ashby", ['""'], "Berlin")).toBeNull();
  });
});

describe("boardsFromResults", () => {
  it("keeps official boards only, once each, without the boards that are already known", () => {
    const boards = boardsFromResults(fixture, new Set(["lever:pipewerk"]));
    expect(boards.map((b) => `${b.ats}:${b.token}`)).toEqual([
      "ashby:examplelabs",
      "personio:betagmbh",
      "lever:gamma",
      "greenhouse:delta",
      "smartrecruiters:EpsilonGroup",
    ]);
    expect(boards[0]).toMatchObject({ boardUrl: "https://jobs.ashbyhq.com/examplelabs", title: "Machine Learning Engineer - Example Labs" });
    expect(boards[2]).toMatchObject({ region: "eu", boardUrl: "https://jobs.eu.lever.co/gamma" });
    expect(boards[1]?.boardUrl).toBe("https://betagmbh.jobs.personio.de");
  });

  it("treats a response without web results as empty and another shape as a parse error", () => {
    expect(boardsFromResults({ type: "search" }, new Set())).toEqual([]);
    expect(() => boardsFromResults({ web: { results: "x" } }, new Set())).toThrow(/expected shape/);
  });
});

describe("brave channel", () => {
  const search = (answer = response(200, fixture)) => routedFetch([["api.search.brave.com/res/v1/web/search", answer]]);

  it("is 'not configured' without BRAVE_SEARCH_API_KEY: no request, no failure, nothing written", async () => {
    const { deps: d, store } = deps({ environment: {} });
    const { fetch, requests } = search();
    const { ctx, query, logs } = atsContext("brave", fetch);
    expect(await createBraveChannel(d).collect(query, ctx)).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(store.candidates.size).toBe(0);
    expect(logs.some((l) => l.message === "brave discovery is not configured")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("test-key");
  });

  it("an empty key counts as not configured", async () => {
    const { deps: d } = deps({ environment: { BRAVE_SEARCH_API_KEY: "  " } });
    const { fetch, requests } = search();
    const { ctx, query } = atsContext("brave", fetch);
    await createBraveChannel(d).collect(query, ctx);
    expect(requests).toHaveLength(0);
  });

  it("searches every query with the key header and stores the new boards as candidates", async () => {
    const { deps: d, store } = deps();
    const { fetch, requests } = search();
    const { ctx, query, logs, sleeps } = atsContext("brave", fetch);
    expect(await createBraveChannel(d).collect(query, ctx)).toEqual([]);

    expect(requests).toHaveLength(30);
    expect(sleeps).toHaveLength(29);
    const first = new URL(requests[0]?.url ?? "");
    expect(first.origin + first.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(first.searchParams.get("count")).toBe("20");
    expect(first.searchParams.get("country")).toBe("DE");
    expect(first.searchParams.get("safesearch")).toBe("strict");
    expect(first.searchParams.get("q")).toContain("site:boards.greenhouse.io");
    expect(requests[0]?.headers["X-Subscription-Token"]).toBe("test-key-not-real");

    expect([...store.candidates.keys()].sort()).toEqual(["ashby:examplelabs", "greenhouse:delta", "lever:gamma", "personio:betagmbh", "smartrecruiters:EpsilonGroup"]);
    expect(store.candidates.get("lever:gamma")).toMatchObject({ region: "eu" });
    expect(store.runs).toBe(1);
    expect(logs.find((l) => l.message === "brave discovery done")?.fields).toMatchObject({ searches: 30, failedSearches: 0, candidates: 5, newCandidates: 5 });
    expect(JSON.stringify(logs)).not.toContain("test-key");
  });

  it("obeys max_queries_per_run and the minimum interval between runs", async () => {
    const { deps: d, store } = deps();
    const channels = configRegistry.channels.schema.parse(
      (() => {
        const raw = structuredClone(shippedYaml("sources.yaml")) as { sources: { brave: Record<string, unknown> } };
        raw.sources.brave.max_queries_per_run = 3;
        return raw;
      })(),
    );
    const first = search();
    const a = atsContext("brave", first.fetch, { channels });
    await createBraveChannel(d).collect(a.query, a.ctx);
    expect(first.requests).toHaveLength(3);

    // a second run right away is skipped
    const second = search();
    const b = atsContext("brave", second.fetch, { channels });
    await createBraveChannel(d).collect(b.query, b.ctx);
    expect(second.requests).toHaveLength(0);
    expect(b.logs.some((l) => l.message === "brave discovery ran recently; skipped")).toBe(true);

    // ... until the interval has passed
    store.last = new Date(Date.now() - 21 * 3_600_000);
    const third = search();
    const c = atsContext("brave", third.fetch, { channels });
    await createBraveChannel(d).collect(c.query, c.ctx);
    expect(third.requests).toHaveLength(3);
  });

  it("a dry run searches but writes nothing and ignores the run marker", async () => {
    const { deps: d, store } = deps();
    store.last = new Date();
    const { fetch, requests } = search();
    const { ctx, query, logs } = atsContext("brave", fetch, { cycleId: null });
    await createBraveChannel(d).collect(query, ctx);
    expect(requests).toHaveLength(30);
    expect(store.candidates.size).toBe(0);
    expect(store.runs).toBe(0);
    expect(logs.find((l) => l.message === "brave discovery dry run: candidates")?.fields.boards).toHaveLength(5);
  });

  it("a rejected key stops the run with auth_expired; nothing is marked as run", async () => {
    const { deps: d, store } = deps();
    const { fetch, requests } = search(response(401, { error: "bad token" }));
    const { ctx, query } = atsContext("brave", fetch);
    await expect(createBraveChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "auth_expired" });
    expect(requests).toHaveLength(1);
    expect(store.runs).toBe(0);
  });

  it("keeps what it found when the quota runs out part-way, and fails the run so it is retried", async () => {
    const { deps: d, store } = deps();
    let calls = 0;
    const { fetch } = search();
    const limited: typeof fetch = async (url, init) => {
      calls += 1;
      return calls <= 2 ? fetch(url, init) : response(429, "slow down");
    };
    const { ctx, query } = atsContext("brave", limited);
    await expect(createBraveChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "rate_limited" });
    expect(store.candidates.size).toBe(5);
    expect(store.runs).toBe(0);
  });

  it("one search with an unreadable answer does not stop the others; all failing fails the run", async () => {
    const { deps: d, store } = deps();
    let calls = 0;
    const { fetch } = search();
    const flaky: typeof fetch = async (url, init) => {
      calls += 1;
      return calls === 1 ? response(200, { web: { results: "x" } }) : fetch(url, init);
    };
    const a = atsContext("brave", flaky);
    await createBraveChannel(d).collect(a.query, a.ctx);
    expect(store.candidates.size).toBe(5);
    expect(a.logs.filter((l) => l.message === "brave search failed")).toHaveLength(1);

    const broken = atsContext("brave", routedFetch([["brave.com", response(200, { web: { results: 5 } })]]).fetch);
    await expect(createBraveChannel(deps().deps).collect(broken.query, broken.ctx)).rejects.toMatchObject({ code: "parse" });
  });

  it("never turns a search result into a posting", () => {
    expect(() => createBraveChannel(deps().deps).parse(null)).toThrow(/stores no postings/);
  });
});
