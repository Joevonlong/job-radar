import http from "node:http";
import type { AddressInfo } from "node:net";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createHttpClient } from "@/lib/channels/http";
import { addFavorite, closeDb, getDb, setApplicationStatus, setClosureOverride } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { resetUxTablesCache } from "@/lib/db/repos/ux-tables";
import { listJobsForLinkCheck, recordWatchedCheck } from "@/lib/db/repos/jobs";
import { parseLinkCheck } from "@/lib/jobs/link-check-evidence";
import { publicUrlProblem, type UrlGuard } from "@/lib/net/public-url";
import { runMaintenance } from "@/lib/pipeline";

import { quietLogger } from "../cycle/helpers";
import { pipelineWith } from "../pipeline/helpers";

/**
 * The recheck of watched jobs against a local HTTP server: which jobs are picked, robots.txt, the per-host gap, the body
 * limit, timeouts, and what is written (status and evidence). The phrases come from the test, not from the shipped packs.
 */

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-10T10:00:00Z");
const GAP_MS = 120;
const UA = "RecheckTest/1 (integration test)";

interface Hit {
  path: string;
  at: number;
  userAgent: string | undefined;
}

let server: http.Server;
let other: http.Server;
let base = "";
let otherBase = "";
let otherHits: string[] = [];
let hits: Hit[] = [];
let robots = "User-agent: *\nDisallow: /private/\n";

const page = (body: string) => `<!doctype html><html><head><title>Job</title><script>var t = "no longer accepting applications";</script></head><body>${body}</body></html>`;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  resetUxTablesCache();
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push({ path, at: Date.now(), userAgent: req.headers["user-agent"] });
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end(robots);
      return;
    }
    if (path === "/private/gone") {
      res.writeHead(404).end("not here");
      return;
    }
    if (path === "/unanswered" || path === "/private/unanswered") {
      res.writeHead(503).end("unavailable");
      return;
    }
    if (path.startsWith("/gone")) {
      res.writeHead(path === "/gone410" ? 410 : 404).end("not here");
      return;
    }
    if (path === "/closed") {
      res.writeHead(200, { "content-type": "text/html" }).end(page("<main><h1>AI Engineer</h1><p>Thank you for your interest. We are no longer accepting applications for this role.</p></main>"));
      return;
    }
    if (path === "/sidebar") {
      res.writeHead(200, { "content-type": "text/html" }).end(page('<main><h1>AI Engineer</h1><p>Apply now.</p></main><aside>Other job: no longer accepting applications</aside><div hidden>no longer accepting applications</div>'));
      return;
    }
    if (path === "/to-lan") {
      res.writeHead(302, { location: "http://10.0.0.5/admin" }).end();
      return;
    }
    if (path === "/to-other") {
      res.writeHead(301, { location: `${otherBase}/job/1` }).end();
      return;
    }
    if (path === "/slow-body") {
      // headers at once, the body only after 3 s (longer than the 500 ms timeout)
      res.writeHead(200, { "content-type": "text/html" });
      res.flushHeaders();
      setTimeout(() => res.end(page("late body")), 3000);
      return;
    }
    if (path === "/slow") {
      setTimeout(() => res.writeHead(200).end(page("late")), 2000);
      return;
    }
    if (path === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write(`<html><body><p>${"a ".repeat(400_000)}</p>`);
      res.end("<p>no longer accepting applications</p></body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(page("<main><h1>AI Engineer</h1><p>Apply now.</p></main>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // a second host (another port is another robots.txt origin) whose robots.txt forbids everything
  other = http.createServer((req, res) => {
    otherHits.push(req.url ?? "/");
    if (req.url === "/robots.txt") res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
    else res.writeHead(200, { "content-type": "text/html" }).end(page("<p>Apply now.</p>"));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
  await closeDb();
});

let companyId = 0;
let rawSeq = 0;

beforeEach(async () => {
  hits = [];
  otherHits = [];
  robots = "User-agent: *\nDisallow: /private/\n";
  const db = getDb();
  const [company] = await db.execute<{ id: number }>(sql`insert into companies (name, name_norm) values ('Acme', 'acme') returning id`);
  companyId = Number(company!.id);
  await db.execute(sql`insert into channels (id, family, kind) values ('fx-ats', 'ats', 'api') on conflict do nothing`);
});

async function addJob(title: string, paths: string[], over: { status?: string; checkedAt?: string } = {}): Promise<number> {
  const db = getDb();
  const [job] = await db.execute<{ id: string }>(sql`
    insert into jobs (company_id, title, title_norm, status, first_seen_at, last_seen_at, link_checked_at)
    values (${companyId}, ${title}, ${title.toLowerCase()}, ${over.status ?? "active"}, '2026-10-01T08:00:00Z', '2026-10-09T08:00:00Z', ${over.checkedAt ?? null}::timestamptz)
    returning id`);
  const id = Number(job!.id);
  for (const path of paths) {
    rawSeq += 1;
    const [raw] = await db.execute<{ id: string }>(sql`insert into raw_postings (channel_id, external_id, payload_json, fetched_at) values ('fx-ats', ${`r${rawSeq}`}, '{}'::jsonb, '2026-10-01T08:00:00Z') returning id`);
    await db.execute(sql`insert into job_sources (job_id, raw_posting_id, channel_id, url) values (${id}, ${Number(raw!.id)}, 'fx-ats', ${`${base}${path}`})`);
  }
  return id;
}

async function watched(title: string, paths: string[], over: { status?: string; checkedAt?: string } = {}): Promise<number> {
  const id = await addJob(title, paths, over);
  await addFavorite(getDb(), id);
  return id;
}

async function state(id: number) {
  const [row] = await getDb().execute<{ status: string; link_checked_at: Date | string | null; link_check_json: unknown }>(sql`select status, link_checked_at, link_check_json from jobs where id = ${id}`);
  return { status: row!.status, checkedAt: row!.link_checked_at, evidence: parseLinkCheck(row!.link_check_json) };
}

/**
 * The public-address check of the test: the local test servers (127.0.0.1) pass, every other URL gets the real check with a
 * resolver that knows no names, so a redirect into the LAN is still refused.
 */
const localGuard: UrlGuard = async (target) => (new URL(target).hostname === "127.0.0.1" ? null : publicUrlProblem(target, async () => ["93.184.216.34"]));

const maintenance = (options: { enabled?: boolean; maxPerCycle?: number; maxLinkChecksPerCycle?: number; extraPhrases?: string[]; guard?: UrlGuard | null; now?: Date; unseenAfterDays?: number; unseenIntervalDays?: number } = {}) =>
  runMaintenance(getDb(), { relist: { minGapDays: 9 },
    config: pipelineWith((raw) => {
      const lifecycle = raw.lifecycle as Record<string, unknown>;
      if (options.maxLinkChecksPerCycle !== undefined) lifecycle.max_link_checks_per_cycle = options.maxLinkChecksPerCycle;
      if (options.unseenAfterDays !== undefined) lifecycle.unseen_link_check_after_days = options.unseenAfterDays;
      if (options.unseenIntervalDays !== undefined) lifecycle.unseen_link_check_interval_days = options.unseenIntervalDays;
      (raw.lifecycle as Record<string, unknown>).watch_recheck = {
        interval_hours: 72,
        max_per_cycle: options.maxPerCycle ?? 10,
        per_host_min_interval_ms: GAP_MS,
        timeout_ms: 500,
        max_body_bytes: 65_536,
        user_agent: UA,
      };
    }),
    http: createHttpClient({ settings: { timeoutMs: 500, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 } }),
    logger: quietLogger,
    now: () => options.now ?? NOW,
    watched: { enabled: options.enabled ?? true, extraPhrases: options.extraPhrases ?? ["\\bno longer accepting applications\\b"] },
    ...(options.guard === null ? {} : { urlGuard: options.guard ?? localGuard }),
  });

const pagesHit = () => hits.filter((h) => h.path !== "/robots.txt").map((h) => h.path);

describe("unseen fallback across watched rechecks", () => {
  const DAY = 86_400_000;
  const at = (day: number) => new Date(NOW.getTime() + day * DAY);
  const lastSeen = new Date("2026-09-01T08:00:00Z");
  const intervalDays = 7;

  async function unseenJob(title: string, path: string) {
    const id = await addJob(title, [path]);
    await getDb().execute(sql`update jobs set first_seen_at = ${lastSeen.toISOString()}::timestamptz, last_seen_at = ${lastSeen.toISOString()}::timestamptz where id = ${id}`);
    await getDb().execute(sql`update raw_postings set fetched_at = ${lastSeen.toISOString()}::timestamptz where id in (select raw_posting_id from job_sources where job_id = ${id})`);
    return id;
  }

  async function unseenWatched(title: string, path: string) {
    const id = await unseenJob(title, path);
    await addFavorite(getDb(), id);
    return id;
  }

  async function evidence(id: number) {
    const [row] = await getDb().execute<{ link_check_json: { outcome: string; at: string; unseenCheckedAt?: string }; last_seen_at: Date | string; link_checked_at: Date | string }>(sql`select link_check_json, last_seen_at, link_checked_at from jobs where id = ${id}`);
    return row!;
  }

  it.each([
    ["/private/gone", "closed"],
    ["/private/alive", "active"],
  ])("settles robots-blocked %s by its link alone, once across daily maintenance rounds", async (path, status) => {
    const id = await unseenWatched("Robots fallback", path);
    const counts: number[] = [];
    for (let day = 0; day <= intervalDays + 2; day += 1) {
      const result = await maintenance({ now: at(day), unseenAfterDays: 14, unseenIntervalDays: intervalDays });
      counts.push(result.unseen.checked);
      if (day === 0) {
        expect(result.watched?.robots).toBe(1);
        expect(pagesHit()).toEqual([]); // the recheck obeys robots.txt
      }
      if (day === 1) {
        expect(result.unseen).toEqual({ checked: 1, closed: status === "closed" ? 1 : 0, alive: status === "active" ? 1 : 0 });
        expect(pagesHit()).toEqual(status === "closed" ? [path, path] : [path]); // HEAD, then GET for 404; the plain check ignores robots.txt
        const row = await evidence(id);
        expect(row.link_check_json.unseenCheckedAt).toBe(at(1).toISOString());
        expect(new Date(row.last_seen_at)).toEqual(status === "active" ? at(1) : lastSeen);
      }
    }
    expect(counts).toEqual([0, 1, ...Array<number>(intervalDays + 1).fill(0)]);
    expect((await state(id)).status).toBe(status);
    if (status === "active") {
      const row = await evidence(id);
      expect(row.link_check_json.at).toBe(at(9).toISOString());
      expect(row.link_check_json.unseenCheckedAt).toBe(at(1).toISOString());
    }
  });

  it.each([
    ["/private/unanswered", "robots"],
    ["/unanswered", "unknown"],
  ])("keeps the fallback interval for %s while 72-hour rechecks rewrite the check time", async (path, outcome) => {
    const id = await unseenWatched("Unanswered fallback", path);
    const counts: number[] = [];
    for (let day = 0; day <= intervalDays + 3; day += 1) {
      const result = await maintenance({ now: at(day), unseenAfterDays: 2, unseenIntervalDays: intervalDays });
      counts.push(result.unseen.checked);
      const row = await evidence(id);
      expect(row.link_check_json.outcome).toBe(outcome);
      expect(new Date(row.last_seen_at)).toEqual(lastSeen);
      if (day >= 1 && day <= 8) expect(row.link_check_json.unseenCheckedAt).toBe(at(1).toISOString());
      if (day === 5) {
        expect(result.watched?.checked).toBe(1);
        expect(new Date(row.link_checked_at)).toEqual(at(5));
        expect(row.link_check_json.at).toBe(at(5).toISOString());
      }
      if (day === 9) {
        expect(result.unseen).toEqual({ checked: 1, closed: 0, alive: 0 });
        expect(row.link_check_json.unseenCheckedAt).toBe(at(9).toISOString());
      }
    }
    expect(counts).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  });

  it("gives a robots-blocked watched job a turn under a full link-check cap without shortening its fallback interval", async () => {
    for (let i = 0; i < 9; i += 1) await unseenJob(`Unwatched ${i}`, "/unanswered");
    const id = await unseenWatched("Watched under contention", "/private/unanswered");
    const fallbackDays: number[] = [];
    let rechecks = 0;
    for (let day = 0; day <= 3 * intervalDays; day += 1) {
      hits = [];
      const result = await maintenance({ now: at(day), maxLinkChecksPerCycle: 1, unseenAfterDays: 14, unseenIntervalDays: intervalDays });
      expect(result.unseen).toEqual({ checked: 1, closed: 0, alive: 0 });
      rechecks += result.watched?.robots ?? 0;
      // The watched recheck never requests this robots-blocked page; only the fallback can hit it.
      const fallbackHits = pagesHit().filter((path) => path === "/private/unanswered");
      if (fallbackHits.length > 0) {
        expect(fallbackHits).toHaveLength(2); // HEAD, then GET, both 503
        fallbackDays.push(day);
        expect((await evidence(id)).link_check_json.unseenCheckedAt).toBe(at(day).toISOString());
      }
    }
    expect(rechecks).toBeGreaterThan(1);
    expect(fallbackDays.length).toBeGreaterThan(1);
    for (let i = 1; i < fallbackDays.length; i += 1) expect(fallbackDays[i]! - fallbackDays[i - 1]!).toBeGreaterThanOrEqual(intervalDays);
    expect((await state(id)).status).toBe("active");
  });

  it("keeps the fallback interval across alive and then unknown watched rechecks", async () => {
    const id = await unseenWatched("Changing recheck answer", "/unanswered");
    const recheck = (outcome: "alive" | "unknown", day: number) => recordWatchedCheck(getDb(), id, {
      outcome, httpStatus: outcome === "alive" ? 200 : 503, phrase: null, quote: null, url: `${base}/unanswered`, at: at(day).toISOString(),
    }, at(day));
    const candidates = (day: number) => listJobsForLinkCheck(getDb(), 10, {
      skipWatched: true, unseen: { seenBefore: at(day - 14), checkedBefore: at(day - intervalDays) },
    });
    await recheck("unknown", -4);
    expect((await maintenance({ now: at(0), unseenAfterDays: 14, unseenIntervalDays: intervalDays })).unseen).toEqual({ checked: 1, closed: 0, alive: 0 });
    expect((await evidence(id)).link_check_json.unseenCheckedAt).toBe(at(0).toISOString());

    await recheck("alive", 3.25);
    const alive = await evidence(id);
    expect(alive.link_check_json).toMatchObject({ outcome: "alive", unseenCheckedAt: at(0).toISOString() });
    expect(new Date(alive.last_seen_at)).toEqual(lastSeen);
    expect(await candidates(3.25)).toEqual([]);

    await recheck("unknown", 6.5);
    expect(await candidates(6.75)).toEqual([]);
    expect((await maintenance({ now: at(6.75), unseenAfterDays: 14, unseenIntervalDays: intervalDays })).unseen.checked).toBe(0);
    expect((await evidence(id)).link_check_json).toMatchObject({ outcome: "unknown", unseenCheckedAt: at(0).toISOString() });
    expect(await candidates(intervalDays)).toEqual([]);
    expect((await candidates(intervalDays + 0.25)).map((job) => job.id)).toEqual([id]);
    expect((await maintenance({ now: at(intervalDays + 0.25), unseenAfterDays: 14, unseenIntervalDays: intervalDays })).unseen).toEqual({ checked: 1, closed: 0, alive: 0 });
    expect((await evidence(id)).link_check_json.unseenCheckedAt).toBe(at(intervalDays + 0.25).toISOString());
  });

  it.each(["gone", "phrase"] as const)("never offers a watched job with %s recheck evidence as a fallback candidate", async (outcome) => {
    const id = await watched("Settled", ["/private/alive"]);
    const old = { outcome, httpStatus: outcome === "gone" ? 404 : 200, phrase: null, quote: null, url: `${base}/private/alive`, at: at(-20).toISOString() };
    await getDb().execute(sql`update jobs set last_seen_at = ${lastSeen.toISOString()}::timestamptz, link_check_json = ${JSON.stringify(old)}::jsonb where id = ${id}`);
    expect(await listJobsForLinkCheck(getDb(), 10, { skipWatched: true, unseen: { seenBefore: at(-14), checkedBefore: at(-7) } })).toEqual([]);
    await recordWatchedCheck(getDb(), id, old, at(-20));
    expect(await listJobsForLinkCheck(getDb(), 10, { skipWatched: true, unseen: { seenBefore: at(-14), checkedBefore: at(-7) } })).toEqual([]);
  });

  it.each(["alive", "gone", "phrase", "robots", "unknown"] as const)("keeps the fallback marker when a watched recheck returns %s", async (outcome) => {
    const id = await watched("New answer", ["/a"]);
    await getDb().execute(sql`update jobs set link_check_json = ${JSON.stringify({ outcome: "unknown", unseenCheckedAt: at(-8).toISOString() })}::jsonb where id = ${id}`);
    await recordWatchedCheck(getDb(), id, { outcome, httpStatus: outcome === "gone" ? 404 : outcome === "robots" || outcome === "unknown" ? null : 200, phrase: null, quote: null, url: `${base}/a`, at: NOW.toISOString() }, NOW);
    expect((await evidence(id)).link_check_json.unseenCheckedAt).toBe(at(-8).toISOString());
    expect((await state(id)).evidence?.outcome).toBe(outcome);
  });
});

describe("which jobs are rechecked", () => {
  it("starred jobs and the five following statuses; not new / ignored / judged / recently checked ones; at most max_per_cycle", async () => {
    const star = await watched("Star", ["/a"]);
    const applied = await addJob("Applied", ["/b"]);
    await setApplicationStatus(getDb(), applied, "applied");
    const interviewing = await addJob("Interviewing", ["/c"]);
    await setApplicationStatus(getDb(), interviewing, "interviewing");
    const ignored = await addJob("Ignored", ["/d"]);
    await setApplicationStatus(getDb(), ignored, "archived");
    await addJob("Plain", ["/e"]);
    const judged = await watched("Judged", ["/f"]);
    await setClosureOverride(getDb(), judged, "open", null, NOW);
    await watched("Recent", ["/g"], { checkedAt: "2026-10-09T10:00:00Z" });
    const old = await watched("Old", ["/h"], { checkedAt: "2026-10-01T10:00:00Z" });
    await watched("Closed", ["/i"], { status: "closed" });

    const result = await maintenance({ maxPerCycle: 3 });
    expect(result.watched).toMatchObject({ checked: 3, alive: 3 });
    // never-checked first (by id), then the oldest check
    expect(pagesHit()).toEqual(["/a", "/b", "/c"]);
    hits = [];
    const next = await maintenance();
    expect(next.watched?.checked).toBe(1);
    expect(pagesHit()).toEqual(["/h"]);
    for (const id of [star, applied, interviewing, old]) expect((await state(id)).status).toBe("active");
    expect((await state(star)).evidence).toMatchObject({ outcome: "alive", httpStatus: 200, url: `${base}/a` });
  });

  it("does nothing when switched off, and the possibly-closed link check then still covers watched jobs", async () => {
    await watched("Star", ["/a"]);
    await watched("Possibly", ["/b"], { status: "possibly_closed" });
    const off = await maintenance({ enabled: false });
    expect(off.watched).toBeNull();
    expect(off.linkChecked).toBe(1);
    expect(hits.some((h) => h.path === "/robots.txt")).toBe(false);
  });

  it("a watched possibly-closed job is checked once, by the recheck, not also by the link check; a live page opens it again", async () => {
    const id = await watched("Possibly", ["/b"], { status: "possibly_closed" });
    const result = await maintenance();
    expect(result.linkChecked).toBe(0);
    expect(result.watched?.checked).toBe(1);
    expect(pagesHit()).toEqual(["/b"]);
    // a live posting is a sighting, like a passing link check
    const after = await getDb().execute<{ status: string; last_seen_at: Date | string }>(sql`select status, last_seen_at from jobs where id = ${id}`);
    expect(after[0]!.status).toBe("active");
    expect(new Date(after[0]!.last_seen_at).toISOString()).toBe(NOW.toISOString());
  });

  it("a watched possibly-closed job whose last recheck had no answer (robots / unknown) is left to the plain link check too", async () => {
    const id = await watched("Possibly", ["/private/1"], { status: "possibly_closed", checkedAt: "2026-10-09T10:00:00Z" });
    await getDb().execute(sql`update jobs set link_check_json = '{"outcome":"robots","httpStatus":null,"phrase":null,"quote":null,"url":null,"at":"2026-10-09T10:00:00.000Z"}'::jsonb where id = ${id}`);
    const result = await maintenance();
    // the recheck waits for its interval; the link check (no robots.txt) takes it
    expect(result.watched?.checked).toBe(0);
    expect(result.linkChecked).toBe(1);
    expect((await state(id)).status).toBe("active");
  });
});

describe("what a recheck finds", () => {
  it("404 / 410 close the job; a visible phrase marks it possibly closed with the evidence; a sidebar or hidden phrase does not", async () => {
    const gone = await watched("Gone", ["/gone"]);
    const gone410 = await watched("Gone410", ["/gone410"]);
    const phrase = await watched("Phrase", ["/closed"]);
    const sidebar = await watched("Sidebar", ["/sidebar"]);
    const result = await maintenance();
    expect(result.watched).toMatchObject({ checked: 4, closed: 2, possiblyClosed: 1, alive: 1 });
    expect(await state(gone)).toMatchObject({ status: "closed", evidence: { outcome: "gone", httpStatus: 404 } });
    expect((await state(gone410)).evidence?.httpStatus).toBe(410);
    const hit = await state(phrase);
    expect(hit.status).toBe("possibly_closed");
    expect(hit.evidence).toMatchObject({ outcome: "phrase", httpStatus: 200, url: `${base}/closed`, at: NOW.toISOString() });
    expect(hit.evidence?.quote).toContain("no longer accepting applications");
    expect(hit.evidence!.quote!.length).toBeLessThanOrEqual(200);
    expect((await state(sidebar)).status).toBe("active");
  });

  it("any live link keeps the job open", async () => {
    const id = await watched("Two", ["/gone", "/ok"]);
    await maintenance();
    expect(await state(id)).toMatchObject({ status: "active", evidence: { outcome: "alive", url: `${base}/ok` } });
  });

  it("obeys robots.txt: a disallowed page is not fetched and is recorded as robots", async () => {
    const id = await watched("Private", ["/private/1"]);
    const result = await maintenance();
    expect(result.watched).toMatchObject({ checked: 1, robots: 1 });
    expect(pagesHit()).toEqual([]);
    expect(hits.map((h) => h.path)).toEqual(["/robots.txt"]);
    expect(await state(id)).toMatchObject({ status: "active", evidence: { outcome: "robots", httpStatus: null } });
    expect((await state(id)).checkedAt).not.toBeNull();
  });

  it("sends its User-Agent and keeps the gap between two requests to the host", async () => {
    await watched("A", ["/a"]);
    await watched("B", ["/b"]);
    await maintenance();
    expect(hits.map((h) => h.path)).toEqual(["/robots.txt", "/a", "/b"]);
    expect(hits.every((h) => h.userAgent === UA)).toBe(true);
    for (let i = 1; i < hits.length; i += 1) expect(hits[i]!.at - hits[i - 1]!.at).toBeGreaterThanOrEqual(GAP_MS - 5);
  });

  it("reads a long page only up to max_body_bytes, and a timeout is recorded as not checked", async () => {
    const big = await watched("Big", ["/big"]);
    const slow = await watched("Slow", ["/slow"]);
    const result = await maintenance();
    expect(result.watched).toMatchObject({ checked: 2, alive: 1, unknown: 1 });
    // the phrase sits past the limit: not read, no error
    expect(await state(big)).toMatchObject({ status: "active", evidence: { outcome: "alive" } });
    expect(await state(slow)).toMatchObject({ status: "active", evidence: { outcome: "unknown", httpStatus: null } });
  });

  it("a body that arrives after the timeout is recorded as not checked, with the check time written (the step goes on)", async () => {
    const slow = await watched("SlowBody", ["/slow-body"]);
    const next = await watched("Next", ["/a"]);
    const started = Date.now();
    const result = await maintenance();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.watched).toMatchObject({ checked: 2, unknown: 1, alive: 1 });
    const state1 = await state(slow);
    expect(state1).toMatchObject({ status: "active", evidence: { outcome: "unknown", httpStatus: null } });
    expect(state1.checkedAt).not.toBeNull();
    expect((await state(next)).evidence?.outcome).toBe("alive");
  });

  it("an unknown answer keeps the evidence of an earlier phrase hit; a live page later clears the phrase mark", async () => {
    const id = await watched("Phrase", ["/closed"]);
    await maintenance();
    expect((await state(id)).status).toBe("possibly_closed");
    robots = "User-agent: *\nDisallow: /\n";
    await getDb().execute(sql`update jobs set link_checked_at = '2026-10-01T00:00:00Z' where id = ${id}`);
    await maintenance();
    expect(await state(id)).toMatchObject({ status: "possibly_closed", evidence: { outcome: "phrase" } });
    robots = "";
    await getDb().execute(sql`update job_sources set url = ${`${base}/ok`} where job_id = ${id}`);
    await getDb().execute(sql`update jobs set link_checked_at = '2026-10-01T00:00:00Z' where id = ${id}`);
    await maintenance();
    expect(await state(id)).toMatchObject({ status: "active", evidence: { outcome: "alive" } });
  });
});

describe("only public addresses, every redirect hop checked", () => {
  it("with the real check, a local address is never requested (recorded as not checked)", async () => {
    const id = await watched("Local", ["/a"]);
    const result = await maintenance({ guard: null });
    expect(result.watched).toMatchObject({ checked: 1, unknown: 1 });
    expect(hits).toEqual([]);
    expect((await state(id)).evidence?.outcome).toBe("unknown");
  });

  it("a redirect into the LAN is not followed", async () => {
    const id = await watched("ToLan", ["/to-lan"]);
    const result = await maintenance();
    expect(result.watched).toMatchObject({ checked: 1, unknown: 1 });
    expect(pagesHit()).toEqual(["/to-lan"]);
    expect((await state(id)).status).toBe("active");
  });

  it("a redirect to another host asks that host's robots.txt first, and obeys it", async () => {
    const id = await watched("ToOther", ["/to-other"]);
    const result = await maintenance();
    expect(result.watched).toMatchObject({ checked: 1, robots: 1 });
    expect(pagesHit()).toEqual(["/to-other"]);
    expect(otherHits).toEqual(["/robots.txt"]);
    expect((await state(id)).evidence?.outcome).toBe("robots");
  });
});
