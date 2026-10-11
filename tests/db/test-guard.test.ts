// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, createConnection, getDb } from "@/lib/db/client";
import { acquireInstanceLock } from "@/lib/db/instance-lock";
import { assertTestDatabase, UNREACHABLE_DATABASE_URL, underVitest } from "@/lib/db/test-guard";
import { loadDatabaseEnv } from "@/lib/env";

/** No test may reach the real database, whatever DATABASE_URL says or does not say. */
describe("database guard under Vitest", () => {
  const savedUrl = process.env.DATABASE_URL;
  afterEach(async () => {
    await closeDb();
    process.env.DATABASE_URL = savedUrl;
  });

  it("runs under Vitest", () => {
    expect(underVitest()).toBe(true);
  });

  it("refuses the production database and anything that is not a test database, before a socket is opened", () => {
    expect(() => assertTestDatabase("postgres://jobradar:jobradar@127.0.0.1:5433/jobradar")).toThrow(/Refusing to connect to database "jobradar"/);
    expect(() => assertTestDatabase("postgres://u:p@db:5432/postgres")).toThrow(/"postgres"/);
    expect(() => assertTestDatabase(UNREACHABLE_DATABASE_URL)).toThrow(/"none"/);
    expect(() => createConnection("postgres://jobradar:jobradar@127.0.0.1:5433/jobradar")).toThrow(/Refusing to connect to database/);
  });

  it("never prints the password", () => {
    expect(() => assertTestDatabase("postgres://u:hunter2@127.0.0.1:5433/jobradar")).toThrow(expect.objectContaining({ message: expect.not.stringContaining("hunter2") }));
  });

  it("allows the integration suite's and e2e databases", () => {
    expect(() => assertTestDatabase("postgres://u:p@127.0.0.1:5433/jobradar_test_x")).not.toThrow();
    expect(() => assertTestDatabase("postgres://u:p@127.0.0.1:5433/jobradar_test_abc_premigrate")).not.toThrow();
    expect(() => assertTestDatabase("postgres://u:p@127.0.0.1:5433/jobradar_e2e_3340")).not.toThrow();
  });

  it("is off outside Vitest", () => {
    expect(() => assertTestDatabase("postgres://u:p@127.0.0.1:5433/jobradar", {})).not.toThrow();
  });

  it("an unset DATABASE_URL is 'no database', never the compose default", () => {
    delete process.env.DATABASE_URL;
    expect(() => loadDatabaseEnv()).toThrow(/DATABASE_URL is not set/);
    expect(() => getDb()).toThrow(/DATABASE_URL is not set/);
    // outside Vitest the compose default still applies
    expect(loadDatabaseEnv({}).DATABASE_URL).toBe("postgres://jobradar:jobradar@127.0.0.1:5433/jobradar");
  });

  it("the unit default URL is unreachable and refused by the guard", () => {
    process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    expect(() => getDb()).toThrow(/Refusing to connect to database/);
  });

  it("the instance lock refuses the production database too", async () => {
    await expect(acquireInstanceLock("postgres://jobradar:jobradar@127.0.0.1:5433/jobradar", { name: "test" } as Parameters<typeof acquireInstanceLock>[1])).rejects.toThrow(/Refusing to connect to database/);
  });
});
