// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { acquireConfigWriteLock, CONFIG_WRITE_LOCK_KEY, DbUnavailable } from "@/lib/db/config-write-lock";

/** The database driver, replaced: every query is recorded and answered by `answer`. */
const driver = vi.hoisted(() => ({
  options: [] as unknown[],
  queries: [] as { text: string; values: unknown[] }[],
  answer: (() => []) as (text: string) => unknown[],
  end: vi.fn(async () => {}),
}));

vi.mock("postgres", () => ({
  default: (_url: string, options: unknown) => {
    driver.options.push(options);
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      driver.queries.push({ text, values });
      return driver.answer(text);
    };
    return Object.assign(sql, { end: driver.end });
  },
}));

const URL = "postgres://user:secret@127.0.0.1:5432/jobradar_test_unit";
const KEY = CONFIG_WRITE_LOCK_KEY;

const isTry = (text: string) => text.includes("pg_try_advisory_lock");
const isFence = (text: string) => text.includes("from pg_locks") && !text.includes("pg_stat_activity");
const isUnlock = (text: string) => text.includes("pg_advisory_unlock");

beforeEach(() => {
  driver.options = [];
  driver.queries = [];
  driver.end.mockClear();
  driver.answer = (text) => (isTry(text) ? [{ ok: true, pid: 42 }] : []);
});

async function lockOrFail() {
  const result = await acquireConfigWriteLock(URL, { waitSeconds: 5 });
  if (!result.acquired) throw new Error("expected the lock");
  return result.lock;
}

describe("the client of the config write lock", () => {
  it("takes the advisory lock with one statement that also returns the backend pid", async () => {
    const lock = await lockOrFail();
    expect(lock.pid).toBe(42);
    const [query] = driver.queries;
    expect(query?.text).toContain("pg_try_advisory_lock");
    expect(query?.text).toContain("pg_backend_pid() as pid");
    expect(query?.values).toEqual([KEY[0], KEY[1]]);
  });

  it("uses a connection of its own that must not recycle: one connection, no idle timeout, no lifetime, notices dropped", async () => {
    await lockOrFail();
    expect(driver.options).toHaveLength(1);
    expect(driver.options[0]).toMatchObject({
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
      onnotice: expect.any(Function),
      connection: { application_name: expect.stringMatching(/^job-radar config-write pid=\d+ host=\S+/) },
    });
    // the notice handler must not throw or print
    expect((driver.options[0] as { onnotice: () => unknown }).onnotice()).toBeUndefined();
  });

  it("names the process in application_name, so a refused writer can tell who holds the lock", async () => {
    await lockOrFail();
    const name = (driver.options[0] as { connection: { application_name: string } }).connection.application_name;
    expect(name.startsWith(`job-radar config-write pid=${process.pid} host=`)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("the fence is true only while the same backend still holds the lock", async () => {
    const lock = await lockOrFail();
    driver.answer = (text) => (isFence(text) ? [{ pid: 42, held: true }] : []);
    expect(await lock.fence()).toBe(true);
    const query = driver.queries.at(-1);
    expect(query?.text).toContain("locktype = 'advisory'");
    expect(query?.text).toContain("pid = pg_backend_pid()");
    expect(query?.values).toEqual(expect.arrayContaining([KEY[0], KEY[1]]));

    driver.answer = (text) => (isFence(text) ? [{ pid: 42, held: false }] : []);
    expect(await lock.fence()).toBe(false);
    // the driver reconnected: another backend does not hold our lock, whatever pg_locks says
    driver.answer = (text) => (isFence(text) ? [{ pid: 99, held: true }] : []);
    expect(await lock.fence()).toBe(false);
    driver.answer = () => [];
    expect(await lock.fence()).toBe(false);
  });

  it("a failing fence query is false, never a throw", async () => {
    const lock = await lockOrFail();
    driver.answer = () => { throw new Error("connection terminated"); };
    expect(await lock.fence()).toBe(false);
  });

  it("release unlocks, closes the connection, and is idempotent; afterwards the fence is false", async () => {
    const lock = await lockOrFail();
    await lock.release();
    await lock.release();
    expect(driver.queries.filter((query) => isUnlock(query.text))).toHaveLength(1);
    expect(driver.end).toHaveBeenCalledTimes(1);
    driver.answer = (text) => (isFence(text) ? [{ pid: 42, held: true }] : []);
    expect(await lock.fence()).toBe(false);
  });

  it("release closes the connection even when the unlock fails", async () => {
    const lock = await lockOrFail();
    driver.answer = (text) => { if (isUnlock(text)) throw new Error("gone"); return []; };
    await expect(lock.release()).resolves.toBeUndefined();
    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("a database that cannot be reached is `DbUnavailable`, with the connection closed and no URL in the message", async () => {
    driver.answer = () => { throw new Error(`connect ECONNREFUSED ${URL}`); };
    const error = await acquireConfigWriteLock(URL, { waitSeconds: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbUnavailable);
    expect((error as Error).message).not.toContain("secret");
    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("waits up to the limit, then reports the holder it can see", async () => {
    driver.answer = (text) => {
      if (isTry(text)) return [{ ok: false, pid: 42 }];
      return [{ application_name: "job-radar config-write pid=7 host=other", backend_start: new Date(0), backend_start_exact: "1970-01-01T00:00:00.000000Z" }];
    };
    const result = await acquireConfigWriteLock(URL, { waitSeconds: 0 });
    expect(result).toEqual({ acquired: false, holder: { application: "job-radar config-write pid=7 host=other", since: new Date(0) } });
    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("a holder it cannot see is null", async () => {
    driver.answer = (text) => (isTry(text) ? [{ ok: false, pid: 42 }] : []);
    expect(await acquireConfigWriteLock(URL, { waitSeconds: 0 })).toEqual({ acquired: false, holder: null });
  });

  it("refuses a database that is not a test database under vitest, before opening a connection", async () => {
    await expect(acquireConfigWriteLock("postgres://u:p@127.0.0.1:5433/jobradar", { waitSeconds: 1 })).rejects.toThrow(/Refusing to connect/);
    expect(driver.options).toEqual([]);
  });
});
