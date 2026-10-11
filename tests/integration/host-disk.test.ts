import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, setRuntimeState } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { HOST_DISK_KEY, loadDiskStatus, readHostDisk, recordHostDisk } from "@/lib/ops/disk";
import { resolveDockerDataLocation } from "@/lib/ops/docker-data";

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`delete from runtime_state where key = ${HOST_DISK_KEY}`);
});

afterAll(async () => {
  await closeDb();
});

describe("host disk measurement (ai-worker -> runtime_state -> /sources)", () => {
  it("stores the measurement of the given path and reads it back", async () => {
    const db = getDb();
    expect(await readHostDisk(db)).toBeNull();
    expect(await recordHostDisk(db, "/")).toBe(true);
    const record = await readHostDisk(db);
    expect(record).toMatchObject({ diskPath: "/" });
    expect(record?.diskTotalBytes).toBeGreaterThan(0);
    expect(Date.now() - (record?.measuredAt.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it("without a path it measures Docker Desktop's data folder, the volume doctor's disk.docker checks", async () => {
    const db = getDb();
    expect(await recordHostDisk(db)).toBe(true);
    expect(await readHostDisk(db)).toMatchObject({ diskPath: (await resolveDockerDataLocation()).path });
  });

  it("the page status uses a fresh host value (the container disk is not what matters)", async () => {
    const db = getDb();
    await setRuntimeState(db, HOST_DISK_KEY, { diskFreeBytes: 14 * 1024 ** 3, diskTotalBytes: 460 * 1024 ** 3, diskPath: "/Users/me" });
    const status = await loadDiskStatus(db);
    expect(status).toMatchObject({ source: "host", level: "warn", path: "/Users/me", percent: 3 });
  });

  it("falls back to the local measurement without a host value, or when it is stale or malformed", async () => {
    const db = getDb();
    expect(await loadDiskStatus(db)).toMatchObject({ source: "local" });

    await setRuntimeState(db, HOST_DISK_KEY, { diskFreeBytes: 1, diskTotalBytes: 2, diskPath: "/x" });
    await db.execute(sql`update runtime_state set updated_at = now() - interval '3 hours' where key = ${HOST_DISK_KEY}`);
    expect(await loadDiskStatus(db)).toMatchObject({ source: "local" });

    await setRuntimeState(db, HOST_DISK_KEY, { nonsense: true });
    expect(await loadDiskStatus(db)).toMatchObject({ source: "local" });
  });
});
