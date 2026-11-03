import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { parse } from "yaml";

import { hashConfigText, resetConfigCache } from "@/lib/config";
import { acquireConfigWriteLock, type ConfigWriteLockHandle } from "@/lib/db/config-write-lock";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { createIsolatedDb, type IsolatedDb } from "../../helpers/isolated-db";
import { childEnv, connect, lockHolder, lockSessionsOf, makePause, prepareInstall, resultOf, startWriter, stopChildren, tempFiles, textHash, waitUntil } from "./write-lock-helpers";

/** What happens to a writer whose database session goes away while it holds the lock. */
const URL_A = "https://a.example.com";
const URL_B = "https://b.example.com";

let iso: IsolatedDb;
let sql: Sql;
let temp: TempConfig;

const notify = (): string => path.join(temp.configDir, "notify.yaml");
const notifyText = (): string => fs.readFileSync(notify(), "utf8");
const baseUrl = (): unknown => (parse(notifyText()) as { public_base_url?: unknown }).public_base_url;
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => childEnv(temp, iso.url, extra);
const terminate = (backend: number): Promise<unknown> => sql`select pg_terminate_backend(${backend})`;

async function terminateAndWait(backend: number): Promise<void> {
  await terminate(backend);
  await waitUntil("the session to end", async () => (await sql`select 1 from pg_stat_activity where pid = ${backend}`).length === 0);
}

const handles: ConfigWriteLockHandle[] = [];
async function take(waitSeconds = 20): Promise<ConfigWriteLockHandle> {
  const result = await acquireConfigWriteLock(iso.url, { waitSeconds });
  if (!result.acquired) throw new Error(`the lock is held by ${result.holder?.application ?? "?"}`);
  handles.push(result.lock);
  return result.lock;
}

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "lockloss");
  sql = connect(iso.url);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await iso?.drop();
});

beforeEach(() => {
  temp = makeTempConfig();
  prepareInstall(temp, 30);
  resetConfigCache();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.release();
  await stopChildren();
  temp.cleanup();
});

describe("the session is lost while a writer holds the lock", { timeout: 60_000 }, () => {
  it("after the hash check: the ownership check notices, the writer gives up and removes its temp file; the other writer's file stays", async () => {
    const base = textHash(temp, "notify.yaml");
    const pause = makePause(temp.root, "after-hash-check");
    const a = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: base }, env(pause.env));
    await pause.waitReached(a);
    const [backend] = await lockSessionsOf(sql, a.pid);
    expect(await lockHolder(sql)).toBe(backend);
    expect(tempFiles(temp.configDir)).toHaveLength(1);

    await terminateAndWait(backend ?? 0);
    const b = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_B }, baseHash: base }, env());
    expect(await resultOf(b)).toEqual({ status: "saved" });
    const written = notifyText();
    expect(baseUrl()).toBe(URL_B);

    pause.go();
    expect(await resultOf(a)).toEqual({ status: "error", kind: "busy", detail: "lock_lost" });
    expect(notifyText()).toBe(written);
    expect(tempFiles(temp.configDir)).toEqual([]);
    expect(await lockHolder(sql)).toBeNull();
  });

  it("after the ownership check: the write still lands and overwrites the writer that came in between", async () => {
    // The accepted exposure src/lib/config/write-lock.ts describes ("no upper bound"): the check does not fence the commit on the
    // filesystem. This test pins what happens, it does not bless it: if the commit gets a real fence, this changes.
    const base = textHash(temp, "notify.yaml");
    const pause = makePause(temp.root, "after-fence");
    const a = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: base }, env(pause.env));
    await pause.waitReached(a);
    const [backend] = await lockSessionsOf(sql, a.pid);
    await terminateAndWait(backend ?? 0);

    const b = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_B }, baseHash: base }, env());
    expect(await resultOf(b)).toEqual({ status: "saved" });
    expect(baseUrl()).toBe(URL_B);

    pause.go();
    expect(await resultOf(a)).toEqual({ status: "saved" });
    expect(baseUrl()).toBe(URL_A);
    expect(tempFiles(temp.configDir)).toEqual([]);
  });

  it("the writer that lost its session never takes the lock again on the new connection", async () => {
    const pause = makePause(temp.root, "after-hash-check");
    const a = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A } }, env(pause.env));
    await pause.waitReached(a);
    const [backend] = await lockSessionsOf(sql, a.pid);
    await terminateAndWait(backend ?? 0);
    expect(await lockHolder(sql)).toBeNull();
    const before = notifyText();
    pause.go();
    expect(await resultOf(a)).toEqual({ status: "error", kind: "busy", detail: "lock_lost" });
    expect(notifyText()).toBe(before);
    expect(await lockHolder(sql)).toBeNull();
  });
});

describe("after a session was terminated (the lock client directly)", { timeout: 60_000 }, () => {
  it("two waiters ask at the same time: exactly one gets it, the other when that one is done", async () => {
    const holder = await take();
    const order: string[] = [];
    const waiters = (["b", "c"] as const).map(async (name) => {
      const lock = await take();
      order.push(name);
      return { name, lock };
    });
    await sleep(300);
    expect(order).toEqual([]);

    await terminate(holder.pid);
    const first = await Promise.race(waiters);
    await sleep(500);
    expect(order).toHaveLength(1);
    expect(await lockHolder(sql)).toBe(first.lock.pid);
    expect(await first.lock.fence()).toBe(true);

    await first.lock.release();
    const all = await Promise.all(waiters);
    const second = all.find((waiter) => waiter.name !== first.name);
    expect(order).toHaveLength(2);
    expect(await lockHolder(sql)).toBe(second?.lock.pid);
    expect(second?.lock.pid).not.toBe(first.lock.pid);
  });

  it("the old holder's client reconnects: its ownership check says no, and nothing was taken on the new connection", async () => {
    const holder = await take();
    await terminateAndWait(holder.pid);
    // the first check may fail on the closed socket, the next ones run on the reconnected client: all are "not held"
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await holder.fence()).toBe(false);
    expect(await lockHolder(sql)).toBeNull();
  });

  it("the old holder's release does not take the lock from the new holder", async () => {
    const old = await take();
    await terminateAndWait(old.pid);
    const next = await take();
    expect(await old.fence()).toBe(false);
    await old.release();
    expect(await next.fence()).toBe(true);
    expect(await lockHolder(sql)).toBe(next.pid);
    expect(await old.fence()).toBe(false);
  });

  it("a healthy holder's check says yes, a released one's says no", async () => {
    const lock = await take();
    expect(await lock.fence()).toBe(true);
    await lock.release();
    expect(await lock.fence()).toBe(false);
    expect(await lockHolder(sql)).toBeNull();
  });

  it("a waiter that runs out of time names the holder; a role that may not see the holder's session still gets a refusal", async () => {
    const held = await take();
    const refused = await acquireConfigWriteLock(iso.url, { waitSeconds: 1 });
    expect(refused).toMatchObject({ acquired: false });
    expect(refused.acquired ? null : refused.holder?.application).toContain("job-radar config-write pid=");
    const hidden = await acquireConfigWriteLock(await iso.addRole("hidden"), { waitSeconds: 1 });
    expect(hidden).toMatchObject({ acquired: false });
    // Postgres keeps application_name readable for other roles (it only hides the session's state and times).
    expect(hidden.acquired ? "" : hidden.holder?.application).toContain("job-radar config-write");
    await held.release();
  });
});

describe("the holder is killed", { timeout: 60_000 }, () => {
  it.each(["after-hash-check", "before-publish"] as const)("SIGKILL at %s: the next writer gets the lock at once, the file is the original", async (stage) => {
    const original = notifyText();
    const pause = makePause(temp.root, stage);
    const a = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_A }, baseHash: textHash(temp, "notify.yaml") }, env(pause.env));
    await pause.waitReached(a);
    a.proc.kill("SIGKILL");
    await a.exited;
    const started = Date.now();
    const next = await take(10);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(notifyText()).toBe(original);
    expect(hashConfigText(notifyText())).toBe(hashConfigText(original));
    await next.release();
    // a later save is not bothered by the temp file left behind
    expect(tempFiles(temp.configDir)).toHaveLength(1);
    const b = startWriter({ op: "save", name: "notify", patch: { public_base_url: URL_B }, baseHash: textHash(temp, "notify.yaml") }, env());
    expect(await resultOf(b)).toEqual({ status: "saved" });
    expect(baseUrl()).toBe(URL_B);
  });
});
