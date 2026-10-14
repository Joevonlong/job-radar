import { describe, expect, it } from "vitest";

import { loadDatabaseEnv, loadRunnerEnv, parseLogLevelEnv } from "@/lib/env";

describe("loadDatabaseEnv", () => {
  it("accepts a postgres URL and applies defaults", () => {
    expect(loadDatabaseEnv({ DATABASE_URL: "postgres://u:p@db:5432/x" })).toEqual({
      DATABASE_URL: "postgres://u:p@db:5432/x",
      DB_POOL_MAX: 10,
      DB_CONNECT_TIMEOUT_SECONDS: 5,
    });
  });

  it("treats empty strings as unset", () => {
    const env = loadDatabaseEnv({ DATABASE_URL: "postgres://u:p@db/x", DB_POOL_MAX: "", MIGRATIONS_DIR: "" });
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.MIGRATIONS_DIR).toBeUndefined();
  });

  it("defaults DATABASE_URL to the host address of the compose db service when it is missing or empty", () => {
    const expected = "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar";
    expect(loadDatabaseEnv({}).DATABASE_URL).toBe(expected);
    expect(loadDatabaseEnv({ DATABASE_URL: "  " }).DATABASE_URL).toBe(expected);
  });

  it("builds the default from POSTGRES_* and DB_HOST_PORT, URL-encoding the password", () => {
    const env = loadDatabaseEnv({ POSTGRES_USER: "u", POSTGRES_PASSWORD: "p@ss/w", POSTGRES_DB: "d", DB_HOST_PORT: "6000" });
    expect(env.DATABASE_URL).toBe("postgres://u:p%40ss%2Fw@127.0.0.1:6000/d");
  });

  it("lets an explicit DATABASE_URL win over POSTGRES_*", () => {
    expect(loadDatabaseEnv({ DATABASE_URL: "postgres://a:b@h:1/c", POSTGRES_USER: "u" }).DATABASE_URL).toBe("postgres://a:b@h:1/c");
  });

  it("never echoes a malformed URL (it may contain a password)", () => {
    expect(() => loadDatabaseEnv({ DATABASE_URL: "mysql://root:hunter2@host/db" })).toThrow(/DATABASE_URL/);
    try {
      loadDatabaseEnv({ DATABASE_URL: "mysql://root:hunter2@host/db" });
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });
});

describe("loadRunnerEnv", () => {
  it("defaults the heartbeat to 30 seconds", () => {
    expect(loadRunnerEnv({}).RUNNER_HEARTBEAT_SECONDS).toBe(30);
  });

  it("reads and validates the heartbeat interval", () => {
    expect(loadRunnerEnv({ RUNNER_HEARTBEAT_SECONDS: "5" }).RUNNER_HEARTBEAT_SECONDS).toBe(5);
    expect(() => loadRunnerEnv({ RUNNER_HEARTBEAT_SECONDS: "0" })).toThrow(/RUNNER_HEARTBEAT_SECONDS/);
    expect(() => loadRunnerEnv({ RUNNER_HEARTBEAT_SECONDS: "abc" })).toThrow(/RUNNER_HEARTBEAT_SECONDS/);
  });

  it("has defaults for the healthcheck limit, the backup directory and pg_dump", () => {
    const env = loadRunnerEnv({});
    expect(env.RUNNER_HEALTH_MAX_AGE_SECONDS).toBe(120);
    expect(env.RUNNER_BACKUP_DIR).toBe("data/backups");
    expect(env.PG_DUMP_PATH).toBe("pg_dump");
  });

  it("reads and validates the environment variables, treating empty values as unset", () => {
    const env = loadRunnerEnv({ RUNNER_HEALTH_MAX_AGE_SECONDS: "300", RUNNER_BACKUP_DIR: "/mnt/backups", PG_DUMP_PATH: "/usr/lib/postgresql/17/bin/pg_dump" });
    expect(env).toMatchObject({ RUNNER_HEALTH_MAX_AGE_SECONDS: 300, RUNNER_BACKUP_DIR: "/mnt/backups", PG_DUMP_PATH: "/usr/lib/postgresql/17/bin/pg_dump" });
    expect(loadRunnerEnv({ RUNNER_HEALTH_MAX_AGE_SECONDS: "", RUNNER_BACKUP_DIR: "", PG_DUMP_PATH: "" }).RUNNER_HEALTH_MAX_AGE_SECONDS).toBe(120);
    expect(() => loadRunnerEnv({ RUNNER_HEALTH_MAX_AGE_SECONDS: "0" })).toThrow(/RUNNER_HEALTH_MAX_AGE_SECONDS/);
  });
});

describe("parseLogLevelEnv", () => {
  it.each(["debug", "info", "warn", "error"])("accepts %s", (level) => {
    expect(parseLogLevelEnv({ JOB_RADAR_LOG_LEVEL: level })).toEqual({ level, invalid: false });
  });

  it("ignores case and surrounding spaces", () => {
    expect(parseLogLevelEnv({ JOB_RADAR_LOG_LEVEL: "  Warn " })).toEqual({ level: "warn", invalid: false });
  });

  it("treats a missing, empty or blank value as unset, not as invalid", () => {
    expect(parseLogLevelEnv({})).toEqual({ level: undefined, invalid: false });
    expect(parseLogLevelEnv({ JOB_RADAR_LOG_LEVEL: "" })).toEqual({ level: undefined, invalid: false });
    expect(parseLogLevelEnv({ JOB_RADAR_LOG_LEVEL: "   " })).toEqual({ level: undefined, invalid: false });
  });

  it.each(["verbose", "trace", "0", "debug,info"])("refuses %j: unset and flagged, without throwing", (value) => {
    expect(parseLogLevelEnv({ JOB_RADAR_LOG_LEVEL: value })).toEqual({ level: undefined, invalid: true });
  });
});
