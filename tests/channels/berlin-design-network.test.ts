// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createBerlinDesignNetworkChannel, jobsUrl, linksFromPage } from "@/lib/channels/berlin-design-network";
import { createChannelContext } from "@/lib/channels/context";
import { createMemoryDiscoveryStore } from "@/lib/channels/discovery";
import { ChannelError } from "@/lib/channels/errors";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { buildSweepQuery } from "@/lib/channels/query";
import type { ChannelContext, HttpResponse } from "@/lib/channels/types";
import { companiesSchema, type BerlinDesignNetworkSettings } from "@/lib/config";

import { shippedChannels, shippedSearch } from "./helpers";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/berlin-design-network");
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const JOBS = read("jobs.html");

const NOW = new Date("2026-10-24T09:00:00Z");
const BOARDS = ["personio:pers-one", "ashby:ashby-fiction", "greenhouse:green-fiction", "lever:lever-fiction", "lever:lever-eu-fiction", "smartrecruiters:SmartFiction", "ashby:no-name-fiction", "personio:mixed-case"];

const settings = (overrides: Partial<BerlinDesignNetworkSettings> = {}): BerlinDesignNetworkSettings => ({ ...shippedChannels().sources.berlin_design_network, enabled: true, ...overrides });

function response(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => lower[name.toLowerCase()] ?? null }, text: async () => body, json: async () => JSON.parse(body) as unknown };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

function makeContext(handler: (call: Call, n: number) => HttpResponse | Error, options: { real?: boolean; maxRetries?: number; records?: LogRecord[] } = {}) {
  const calls: Call[] = [];
  const ctx: ChannelContext = createChannelContext({
    channelId: "berlin_design_network",
    settings: { enabled: true, maxResults: 100, monthlyBudgetUsd: 0, companyQueries: false, freeRecordsPerMonth: 0, throttle: { minDelayMs: 1, maxDelayMs: 1 }, extra: settings() },
    http: { timeoutMs: 1000, maxRetries: options.maxRetries ?? 0, backoffBaseMs: 10, backoffMaxMs: 5000 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: new AbortController().signal,
    cycle: options.real ? { id: 1, kind: "manual" } : { id: null, kind: "manual" },
    logger: createLogger({ sink: (r) => options.records?.push(r), minLevel: "debug" }),
    known: { payloads: async () => new Map() },
    sleep: async () => undefined,
    random: () => 0,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers ?? {}, redirect: init.redirect });
      const result = handler(calls.at(-1) as Call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { ctx, calls };
}

function build(options: { boards?: Array<{ ats: "personio"; token: string }> } = {}) {
  const store = createMemoryDiscoveryStore();
  const companies = companiesSchema.parse({ companies: (options.boards ?? [{ ats: "personio", token: "Known-Fiction" }]).map((b) => ({ name: b.token, ats: b.ats, token: b.token, enabled: false })) });
  return { store, channel: createBerlinDesignNetworkChannel({ companies: () => companies, store: () => store, now: () => NOW }) };
}

const query = () => buildSweepQuery(shippedSearch(), "manual");
const page = (): HttpResponse => response(200, JOBS);

describe("linksFromPage", () => {
  it("reads the link and the company name of each entry and counts the entries of a wrong shape", () => {
    const result = linksFromPage(JOBS);
    expect(result.total).toBe(18);
    expect(result.invalid).toBe(3);
    expect(result.links).toHaveLength(15);
    expect(result.links[0]).toEqual({ url: "https://pers-one.jobs.personio.de/job/111?utm_source=BerlinDesignNetwork", label: "Persona One GmbH" });
    expect(result.links.find((l) => l.url.includes("no-name-fiction"))?.label).toBeNull();
    expect(result.links.find((l) => l.url.includes("SmartFiction"))?.label).toBeNull();
    expect(result.links.find((l) => l.url.includes("mixed-case"))?.label).toBe("Padded Name");
  });

  it("keeps nothing of the companies' contact details", () => {
    expect(JOBS).toContain("hiring@fiction.example");
    const dump = JSON.stringify(linksFromPage(JOBS));
    for (const secret of ["hiring@fiction.example", "+49 30", "Nowhere", "contact_", "at_company\""]) expect(dump).not.toContain(secret);
  });

  it.each([
    ["no-data.html", "no embedded job list"],
    ["broken-json.html", ""],
    ["jobs-not-array.html", "expected shape"],
    ["other-shape.html", "expected shape"],
  ])("%s is a parse error", (name, message) => {
    let error: unknown;
    try {
      linksFromPage(read(name));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "parse" });
    expect((error as Error).message).toContain(message);
  });
});

describe("berlin_design_network channel", () => {
  it("is a board-discovery channel: family ats, no queries, no catch-up", () => {
    const { channel } = build();
    expect(channel).toMatchObject({ id: "berlin_design_network", family: "ats", kind: "api", usesQueries: false });
    expect(channel.supportsCatchUp?.(makeContext(page).ctx.settings)).toBe(false);
  });

  it("writes one candidate per official board, named by the company, tagged with the source, and returns no postings", async () => {
    const { store, channel } = build();
    const { ctx, calls } = makeContext(page, { real: true });
    await expect(channel.collect(query(), ctx)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(jobsUrl(settings()));
    expect(calls[0]?.headers["User-Agent"]).toBe(settings().user_agent);
    expect([...store.candidates.keys()].sort()).toEqual([...BOARDS].sort());
    expect([...store.foundBy.values()].every((v) => v.length === 1 && v[0] === "berlin_design_network")).toBe(true);
    expect(store.candidates.get("personio:pers-one")).toMatchObject({ title: "Persona One GmbH" });
    expect(store.candidates.get("ashby:no-name-fiction")).toMatchObject({ title: null });
    expect(store.runs).toBe(1);
  });

  it("leaves out the boards ats_boards lists and every link that is not an official board", async () => {
    const { store, channel } = build();
    await channel.collect(query(), makeContext(page, { real: true }).ctx);
    const keys = [...store.candidates.keys()];
    expect(keys).not.toContain("personio:known-fiction");
    expect(keys.some((k) => /linkedin|stepstone|baito|company-fiction|dot-com/i.test(k))).toBe(false);
    expect(keys).toHaveLength(BOARDS.length);
  });

  it("stores no contact details in the candidates or the log", async () => {
    const { store, channel } = build();
    const records: LogRecord[] = [];
    await channel.collect(query(), makeContext(page, { real: true, records }).ctx);
    const dump = JSON.stringify([[...store.candidates.values()], records]);
    for (const secret of ["hiring@fiction.example", "+49 30", "Nowhere"]) expect(dump).not.toContain(secret);
    expect(records.some((r) => r.message.includes("unexpected shape"))).toBe(true);
  });

  it("does nothing, and sends no request, while the last run is younger than the interval", async () => {
    const { store, channel } = build();
    store.last = new Date(NOW.getTime() - 3 * 3_600_000);
    const { ctx, calls } = makeContext(page, { real: true });
    await expect(channel.collect(query(), ctx)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
    expect(store.candidates.size).toBe(0);
    store.last = new Date(NOW.getTime() - 25 * 3_600_000);
    await channel.collect(query(), makeContext(page, { real: true }).ctx);
    expect(store.candidates.size).toBe(BOARDS.length);
  });

  it("a dry run reads and writes no marker and no candidate, and logs the boards it found", async () => {
    const { store, channel } = build();
    store.last = new Date(NOW.getTime() - 60_000);
    const records: LogRecord[] = [];
    const { ctx, calls } = makeContext(page, { records });
    await expect(channel.collect(query(), ctx)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(store.candidates.size).toBe(0);
    expect(store.runs).toBe(0);
    const dry = records.find((r) => r.message.includes("dry run"));
    expect((dry?.fields as { boards: string[] }).boards).toHaveLength(BOARDS.length);
  });

  it("writes no marker and no candidate when the page cannot be read, and tries again next time", async () => {
    const { store, channel } = build();
    await expect(channel.collect(query(), makeContext(() => response(200, read("no-data.html")), { real: true }).ctx)).rejects.toMatchObject({ code: "parse" });
    expect(store.candidates.size + store.runs).toBe(0);
  });

  it("maps 403 to blocked and retries 429 and 5xx", async () => {
    const { channel } = build();
    await expect(channel.collect(query(), makeContext(() => response(403, "no"), { real: true }).ctx)).rejects.toMatchObject({ code: "blocked" });
    const { ctx, calls } = makeContext((_call, n) => (n === 0 ? response(429, "slow", { "Retry-After": "0" }) : n === 1 ? response(503, "down") : page()), { real: true, maxRetries: 2 });
    await expect(channel.collect(query(), ctx)).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("follows a redirect within the site only", async () => {
    const { channel } = build();
    const within = makeContext((call) => (call.url.endsWith("/jobs") ? response(308, "", { Location: "/jobs/" }) : page()));
    await expect(channel.collect(query(), within.ctx)).resolves.toEqual([]);
    expect(within.calls.map((c) => c.url)).toEqual(["https://berlin-design-network.org/jobs", "https://berlin-design-network.org/jobs/"]);
    expect(within.calls.every((c) => c.redirect === "manual")).toBe(true);

    const away = makeContext(() => response(302, "", { Location: "https://elsewhere.example/jobs" }));
    await expect(channel.collect(query(), away.ctx)).rejects.toMatchObject({ code: "blocked" });
    expect(away.calls).toHaveLength(1);

    const loop = makeContext(() => response(302, "", { Location: "/jobs" }));
    await expect(channel.collect(query(), loop.ctx)).rejects.toMatchObject({ code: "network" });
    expect(loop.calls).toHaveLength(4);
  });

  it("rejects an unusable settings block", async () => {
    const { channel } = build();
    const { ctx } = makeContext(page);
    const broken = { ...ctx, settings: { ...ctx.settings, extra: { enabled: true } } } as ChannelContext;
    await expect(channel.collect(query(), broken)).rejects.toMatchObject({ code: "unknown" });
  });

  it("parse refuses: no postings are stored", () => {
    const { channel } = build();
    expect(() => channel.parse({})).toThrow(ChannelError);
    expect(() => channel.parse({})).toThrow(/stores no postings/);
  });
});
