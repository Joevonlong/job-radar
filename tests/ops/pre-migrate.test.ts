// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { migrateWithBackup, PreMigrateBackupError, preMigrateLabel, type MigrateWithBackupDeps } from "@/lib/ops/pre-migrate-backup";

function deps(overrides: Partial<MigrateWithBackupDeps> & { applied?: number; shipped?: number | null } = {}) {
  const calls: string[] = [];
  const shipped = overrides.shipped === undefined ? 10 : overrides.shipped;
  const value: MigrateWithBackupDeps = {
    config: { pre_migrate: true },
    readJournal: async () => (shipped === null ? null : { count: shipped, latestAt: 1 }),
    readApplied: async () => ({ count: overrides.applied ?? 8 }),
    runBackup: vi.fn(async (label: string) => {
      calls.push(`backup:${label}`);
      return { file: `jobradar-manual-20261007-033000-${label}.dump` };
    }),
    runMigrations: vi.fn(async () => {
      calls.push("migrate");
    }),
    ...overrides,
  };
  return { value, calls };
}

describe("migrateWithBackup", () => {
  it("backs up first when the database has data and migrations are pending, then migrates", async () => {
    const { value, calls } = deps({ applied: 8, shipped: 10 });
    const result = await migrateWithBackup(value);
    expect(calls).toEqual(["backup:premigrate-8-10", "migrate"]);
    expect(result).toEqual({ backup: "jobradar-manual-20261007-033000-premigrate-8-10.dump", applied: 8, shipped: 10 });
    expect(preMigrateLabel(8, 10)).toBe("premigrate-8-10");
  });

  it("also treats migrations as pending when the newest shipped one is newer than the newest applied, with the same count", async () => {
    const { value, calls } = deps({ applied: 10, shipped: 10, readApplied: async () => ({ count: 10, latestAt: 0 }) });
    await migrateWithBackup(value);
    expect(calls).toEqual(["backup:premigrate-10-10", "migrate"]);
    const same = deps({ applied: 10, shipped: 10, readApplied: async () => ({ count: 10, latestAt: 1 }) });
    await migrateWithBackup(same.value);
    expect(same.calls).toEqual(["migrate"]);
  });

  it("does not back up a brand-new database (nothing applied, nothing to lose)", async () => {
    const { value, calls } = deps({ applied: 0, shipped: 10 });
    expect((await migrateWithBackup(value)).backup).toBeNull();
    expect(calls).toEqual(["migrate"]);
  });

  it("does not back up when the database is already up to date, or newer than the code", async () => {
    for (const applied of [10, 12]) {
      const { value, calls } = deps({ applied, shipped: 10 });
      await migrateWithBackup(value);
      expect(calls).toEqual(["migrate"]);
    }
  });

  it("does not back up when the journal cannot be read (the migration itself will report that)", async () => {
    const { value, calls } = deps({ shipped: null });
    await migrateWithBackup(value);
    expect(calls).toEqual(["migrate"]);
  });

  it("skips the backup when backup.pre_migrate is off", async () => {
    const { value, calls } = deps({ config: { pre_migrate: false } });
    const log = vi.fn();
    await migrateWithBackup({ ...value, log });
    expect(calls).toEqual(["migrate"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("backup.pre_migrate is off"));
  });

  it("does NOT migrate when the backup fails, and names the way out without leaking the cause's details", async () => {
    const { value } = deps();
    value.runBackup = vi.fn(async () => {
      throw new Error("pg_dump exited with code 1: no space left");
    });
    const error = await migrateWithBackup(value).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreMigrateBackupError);
    expect((error as Error).message).toContain("nothing was migrated");
    expect((error as Error).message).toContain("backup.pre_migrate: false");
    expect(value.runMigrations).not.toHaveBeenCalled();
  });
});
