import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertDemoDbName, assertThrowawayDir, demoDbNameOf, demoInstance, demoNow, DemoCheckError } from "../../scripts/demo/checks";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("demo database names", () => {
  it.each(["jobradar_demo", "jobradar_demo_2", "jobradar_demo3190"])("accepts %s", (name) => {
    expect(assertDemoDbName(name)).toBe(name);
  });

  it.each(["jobradar", "jobradar_e2e", "postgres", "jobradar_demo-x", 'jobradar_demo"; drop', "JOBRADAR_DEMO", "x_jobradar_demo"])("refuses %s", (name) => {
    expect(() => assertDemoDbName(name)).toThrow(DemoCheckError);
  });

  it("reads the name from a URL", () => {
    expect(demoDbNameOf("postgres://u:p@127.0.0.1:5433/jobradar_demo")).toBe("jobradar_demo");
    expect(() => demoDbNameOf("postgres://u:p@127.0.0.1:5433/jobradar")).toThrow(DemoCheckError);
    expect(() => demoDbNameOf("not a url")).toThrow(DemoCheckError);
  });
});

describe("throw-away directories", () => {
  const tmp = fs.realpathSync(os.tmpdir());

  it("accepts a directory inside a temp root", () => {
    expect(assertThrowawayDir(path.join(tmp, "job-radar-demo", "config"), "dir", [tmp])).toBe(path.join(tmp, "job-radar-demo", "config"));
  });

  it.each([
    ["unset", undefined],
    ["the temp root itself", "<tmp>"],
    ["a home directory", os.homedir()],
    ["the repository", ROOT],
    ["an escape with ..", "<tmp>/../etc"],
    ["a temp directory of another program", "<tmp>/other-app/config"],
    ["a name that only contains the prefix", "<tmp>/x-job-radar-demo/config"],
  ])("refuses %s", (_name, dir) => {
    expect(() => assertThrowawayDir(dir?.replace("<tmp>", tmp), "dir", [tmp])).toThrow(DemoCheckError);
  });
});

describe("demoInstance", () => {
  it("derives the demo database from the admin URL", () => {
    const instance = demoInstance({ DEMO_ADMIN_DATABASE_URL: "postgres://u:p@127.0.0.1:5433/postgres" });
    expect(instance.dbName).toBe("jobradar_demo");
    expect(new URL(instance.databaseUrl).pathname).toBe("/jobradar_demo");
  });

  it.each([
    ["no admin URL", {}],
    ["a non-demo database", { DEMO_ADMIN_DATABASE_URL: "postgres://u:p@h/postgres", DEMO_DB_NAME: "jobradar" }],
    ["a config directory outside temp", { DEMO_ADMIN_DATABASE_URL: "postgres://u:p@h/postgres", DEMO_CONFIG_DIR: os.homedir() }],
    ["a profile directory outside temp", { DEMO_ADMIN_DATABASE_URL: "postgres://u:p@h/postgres", DEMO_PROFILE_DIR: ROOT }],
  ])("refuses %s", (_name, env) => {
    expect(() => demoInstance(env)).toThrow(DemoCheckError);
  });
});

describe("demo-prepare refuses before touching anything", () => {
  it.each([[[]], [["--drop"]]])("with a non-demo database name (args %j)", (args) => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/demo-prepare.ts", ...args], {
      cwd: ROOT,
      // an unreachable server: a refusal must come before any connection
      env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, DEMO_ADMIN_DATABASE_URL: "postgres://u:p@127.0.0.1:1/postgres", DEMO_DB_NAME: "jobradar" },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("jobradar_demo");
  });

  it("with a config directory outside temp", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/demo-prepare.ts", "--drop"], {
      cwd: ROOT,
      env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, DEMO_ADMIN_DATABASE_URL: "postgres://u:p@127.0.0.1:1/postgres", DEMO_CONFIG_DIR: ROOT },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(fs.existsSync(path.join(ROOT, "package.json"))).toBe(true);
  });
});

describe("demoNow", () => {
  it("is 10:00 Berlin time today, or yesterday before 10:00", () => {
    expect(demoNow(new Date("2026-10-10T12:00:00Z")).toISOString()).toBe("2026-10-10T08:00:00.000Z");
    expect(demoNow(new Date("2026-10-10T07:00:00Z")).toISOString()).toBe("2026-10-09T08:00:00.000Z");
    expect(demoNow(new Date("2026-01-15T12:00:00Z")).toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  it("gives the same instant for two runs on the same day", () => {
    expect(demoNow(new Date("2026-10-10T09:00:00Z"))).toEqual(demoNow(new Date("2026-10-10T21:59:00Z")));
  });
});
