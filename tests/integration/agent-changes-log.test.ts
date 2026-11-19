import { spawnSync } from "node:child_process";

import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

import { createConnection, type Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { runMigrations } from "@/lib/db/migrate";
import { checkAgentChangeIdentity, pruneAgentChanges, readAgentChangeLogIdentity, resetAgentChanges } from "@/lib/db/repos/agent-changes";
import { agentChangeLog, agentChanges } from "@/lib/db/schema";

import { createIsolatedDb } from "../helpers/isolated-db";

const url = inject("testDatabaseUrl");
const migrationOptions = { url, currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60_000 } };
const retentionDays = 30;
const old = () => sql`now() - interval '40 days'`;

const openConnection = () => createConnection(url, { max: 1, sessionSettings: { lock_timeout: "8000" } });
let first: ReturnType<typeof openConnection>;
let second: ReturnType<typeof openConnection>;
let observer: ReturnType<typeof openConnection>;

beforeAll(() => {
  first = openConnection();
  second = openConnection();
  observer = openConnection();
});

afterAll(async () => {
  await Promise.all([first, second, observer].map((connection) => connection.sql.end({ timeout: 2 })));
});

async function addChanges(db: Executor, at: ReturnType<typeof old>, ...keys: string[]) {
  return db.insert(agentChanges).values(keys.map((key) => ({ keyKind: "job" as const, key, blocks: 1, at })))
    .returning({ tx: agentChanges.tx, seq: agentChanges.seq });
}

async function remainingKeys(db: Executor) {
  const rows = await db.select({ key: agentChanges.key }).from(agentChanges).orderBy(asc(agentChanges.seq));
  return rows.map(({ key }) => key);
}

async function logState(db: Executor) {
  const [row] = await db.select({
    logId: agentChangeLog.logId, keyId: agentChangeLog.keyId,
    tx: agentChangeLog.prunedThroughTx, seq: agentChangeLog.prunedThroughSeq,
  }).from(agentChangeLog);
  return row;
}

function holdTransaction<T>(db: Db, work: (tx: Executor) => Promise<T>) {
  const ready = Promise.withResolvers<T>();
  const release = Promise.withResolvers<void>();
  const finished = db.transaction(async (tx) => {
    ready.resolve(await work(tx));
    await release.promise;
  });
  void finished.catch(ready.reject);
  return { ready: ready.promise, release: release.resolve, finished };
}

describe("agent change log maintenance", () => {
  it("resets the log and cursor key without changing an open repeatable-read snapshot", async () => {
    await addChanges(first.db, old(), "before-reset");
    await first.db.transaction(async (reader) => {
      const oldLog = await logState(reader);
      expect(oldLog).toBeDefined();
      expect(await remainingKeys(reader)).toEqual(["before-reset"]);

      const logId = await resetAgentChanges(second.db);
      expect(await logState(second.db)).toMatchObject({ logId, tx: null, seq: null });
      expect(logId).not.toBe(oldLog?.logId);
      expect((await logState(second.db))?.keyId).not.toBe(oldLog?.keyId);
      expect(await remainingKeys(second.db)).toEqual([]);

      expect(await logState(reader)).toEqual(oldLog);
      expect(await remainingKeys(reader)).toEqual(["before-reset"]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });

  it("prunes past retention and below xmin, keeping the greatest deleted position", async () => {
    await addChanges(first.db, sql`now()`, "fresh");
    await addChanges(first.db, old(), "old");
    const [, lastEligible] = await addChanges(first.db, old(), "same-tx-first", "same-tx-last");
    const writer = holdTransaction(second.db, (tx) => addChanges(tx, old(), "open"));
    let lastHeldBack;
    try {
      await writer.ready;
      [lastHeldBack] = await addChanges(first.db, old(), "committed-after-open");

      expect(await pruneAgentChanges(first.db, retentionDays)).toBe(3);
      expect(await remainingKeys(first.db)).toEqual(["fresh", "committed-after-open"]);
      expect(await logState(first.db)).toMatchObject(lastEligible!);

      await first.db.update(agentChanges).set({ at: old() }).where(eq(agentChanges.key, "fresh"));
      expect(await pruneAgentChanges(first.db, retentionDays)).toBe(1);
      expect(await logState(first.db)).toMatchObject(lastEligible!);
    } finally {
      writer.release();
      await writer.finished;
    }

    expect(await remainingKeys(first.db)).toEqual(["open", "committed-after-open"]);
    expect(await pruneAgentChanges(first.db, retentionDays)).toBe(2);
    expect(await logState(first.db)).toMatchObject(lastHeldBack!);
    expect(await remainingKeys(first.db)).toEqual([]);
  });

  it.each(["prune", "reset"] as const)("serializes maintenance while %s holds the log row", async (firstOperation) => {
    await addChanges(first.db, old(), "old");
    const original = await logState(first.db);
    const [holder] = await first.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [waiter] = await second.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const hold = holdTransaction<string | number>(first.db, (tx) => firstOperation === "prune"
      ? pruneAgentChanges(tx, retentionDays)
      : resetAgentChanges(tx));

    try {
      await hold.ready;
      const waiting = firstOperation === "prune" ? resetAgentChanges(second.db) : pruneAgentChanges(second.db, retentionDays);
      void waiting.catch(() => {});
      try {
        await vi.waitFor(async () => {
          const [row] = await observer.sql<{ blocked: boolean }[]>`
            select ${holder!.pid}::int = any(pg_blocking_pids(${waiter!.pid})) as blocked`;
          expect(row?.blocked).toBe(true);
        }, { timeout: 5000, interval: 20 });
      } finally {
        hold.release();
        await waiting;
      }
    } finally {
      hold.release();
      await hold.finished;
    }

    const next = await logState(first.db);
    expect(next).toMatchObject({ tx: null, seq: null });
    expect(next?.logId).not.toBe(original?.logId);
    expect(await remainingKeys(first.db)).toEqual([]);
  });

  it.each(["cluster", "database"] as const)("resets after migrations when the %s identity differs", async (identity) => {
    await addChanges(first.db, old(), "before-migrate");
    const before = await readAgentChangeLogIdentity(first.db);
    expect(before).not.toBeNull();
    if (identity === "cluster") {
      await first.sql`update agent_change_log set system_identifier = system_identifier # 1`;
    } else {
      await first.sql`update agent_change_log set database_oid = 0::oid`;
    }
    expect(await checkAgentChangeIdentity(first.db)).toMatchObject({ status: "mismatch" });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMigrations(migrationOptions);
      expect(log).toHaveBeenCalledExactlyOnceWith("agent change log reset after migration");
    } finally {
      log.mockRestore();
    }
    const checked = await checkAgentChangeIdentity(first.db);
    expect(checked).toMatchObject({ status: "match", identity: { systemIdentifier: before!.systemIdentifier, databaseOid: before!.databaseOid } });
    expect((await readAgentChangeLogIdentity(first.db))?.logId).not.toBe(before?.logId);
    expect(await remainingKeys(first.db)).toEqual([]);
  });

  it("resets after migrations if a visible change has a future transaction ID", async () => {
    const before = await logState(first.db);
    await first.db.insert(agentChanges).values({ keyKind: "job", key: "future", blocks: 1, tx: "18446744073709551615" });
    expect(await checkAgentChangeIdentity(first.db)).toMatchObject({ status: "match" });

    await runMigrations(migrationOptions);
    expect((await logState(first.db))?.logId).not.toBe(before?.logId);
    expect(await remainingKeys(first.db)).toEqual([]);
  });

  it("initializes a missing log identity once the database identity is readable", async () => {
    await first.db.delete(agentChangeLog);
    expect(await checkAgentChangeIdentity(first.db)).toEqual({ status: "unavailable", reason: "identity_missing" });

    await runMigrations(migrationOptions);
    expect(await checkAgentChangeIdentity(first.db)).toMatchObject({ status: "match" });
  });

  it("reports identity unavailable inside a read-only snapshot when identity access is revoked", async () => {
    const isolated = await createIsolatedDb(url, "sync_acl");
    const adminUrl = new URL(url);
    adminUrl.pathname = `/${isolated.name}`;
    const admin = createConnection(adminUrl.toString(), { max: 1 });
    const owner = createConnection(isolated.url, { max: 1 });
    try {
      expect(await checkAgentChangeIdentity(owner.db)).toMatchObject({ status: "match" });
      const original = await readAgentChangeLogIdentity(owner.db);
      await admin.sql`revoke execute on function pg_catalog.pg_control_system() from public`;

      const checked = await owner.db.transaction(checkAgentChangeIdentity, { isolationLevel: "repeatable read", accessMode: "read only" });
      expect(checked).toEqual({ status: "unavailable", reason: "identity_unreadable" });
      await runMigrations({ ...migrationOptions, url: isolated.url });
      expect(await readAgentChangeLogIdentity(owner.db)).toEqual(original);
    } finally {
      await Promise.all([admin.sql.end({ timeout: 2 }), owner.sql.end({ timeout: 2 })]);
      await isolated.drop();
    }
  });

  it("preserves the log identity, watermark and changes on a normal restart", async () => {
    await addChanges(first.db, old(), "expired");
    await pruneAgentChanges(first.db, retentionDays);
    await addChanges(first.db, sql`now()`, "retained");
    const before = await logState(first.db);
    expect(before?.tx).toEqual(expect.any(String));

    await runMigrations(migrationOptions);
    expect(await logState(first.db)).toEqual(before);
    expect(await remainingKeys(first.db)).toEqual(["retained"]);
  });

  it("requires --yes and prints just the new log ID when confirmed", async () => {
    await addChanges(first.db, old(), "before-cli");
    const before = await logState(first.db);
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/mcp-sync-reset.ts", ...args], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: url }, timeout: 15_000,
    });

    const refused = run();
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain("pnpm mcp:sync-reset --yes");
    expect(refused.stdout).toBe("");
    expect(await logState(first.db)).toEqual(before);
    expect(await remainingKeys(first.db)).toEqual(["before-cli"]);

    const confirmed = run("--yes");
    expect(confirmed.status, confirmed.stderr).toBe(0);
    const current = await logState(first.db);
    expect(confirmed.stdout.trim()).toBe(current?.logId);
    expect(current?.logId).not.toBe(before?.logId);
    expect(await remainingKeys(first.db)).toEqual([]);
  });
});
