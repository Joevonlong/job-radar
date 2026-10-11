// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDbPassword, envValue, withEnvValue } from "@/lib/ops/db-password";

let dir = "";
let envFile = "";
const PASSWORD = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-dbpw-"));
  envFile = path.join(dir, ".env");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const options = (volume: boolean | null, env: Record<string, string | undefined> = {}) => ({ envFile, env, volumeExists: async () => volume, generate: () => PASSWORD });

describe("dotenv helpers", () => {
  it("reads and sets values without touching the other lines", () => {
    const text = "# comment\nPOSTGRES_USER=\nPOSTGRES_PASSWORD=\nDB_HOST_PORT=5433\n";
    expect(envValue(text, "POSTGRES_PASSWORD")).toBe("");
    expect(envValue(text, "DB_HOST_PORT")).toBe("5433");
    expect(envValue(text, "NOPE")).toBeNull();
    expect(envValue('POSTGRES_PASSWORD="quoted"\n', "POSTGRES_PASSWORD")).toBe("quoted");
    expect(withEnvValue(text, "POSTGRES_PASSWORD", "x")).toBe("# comment\nPOSTGRES_USER=\nPOSTGRES_PASSWORD=x\nDB_HOST_PORT=5433\n");
    expect(withEnvValue("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(withEnvValue("", "B", "2")).toBe("B=2\n");
  });
});

describe("ensureDbPassword", () => {
  it("writes a random password (0600) for a new install: .env missing, or its POSTGRES_PASSWORD empty", async () => {
    expect(await ensureDbPassword(options(false))).toBe("generated");
    expect(fs.readFileSync(envFile, "utf8")).toBe(`POSTGRES_PASSWORD=${PASSWORD}\n`);
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);

    fs.writeFileSync(envFile, "POSTGRES_USER=\nPOSTGRES_PASSWORD=\nTELEGRAM_BOT_TOKEN=keepme\n");
    expect(await ensureDbPassword(options(false))).toBe("generated");
    expect(fs.readFileSync(envFile, "utf8")).toBe(`POSTGRES_USER=\nPOSTGRES_PASSWORD=${PASSWORD}\nTELEGRAM_BOT_TOKEN=keepme\n`);
  });

  it("never changes a password that is set", async () => {
    fs.writeFileSync(envFile, "POSTGRES_PASSWORD=mine\n");
    expect(await ensureDbPassword(options(false))).toBe("has_password");
    expect(fs.readFileSync(envFile, "utf8")).toBe("POSTGRES_PASSWORD=mine\n");
  });

  it("writes nothing when the database volume exists (it keeps the password it was created with) or Docker cannot tell", async () => {
    expect(await ensureDbPassword(options(true))).toBe("database_exists");
    expect(await ensureDbPassword(options(null))).toBe("unknown");
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("writes nothing for an external database (DATABASE_URL set)", async () => {
    expect(await ensureDbPassword(options(false, { DATABASE_URL: "postgres://u:p@h/d" }))).toBe("external_database");
    expect(fs.existsSync(envFile)).toBe(false);
  });
});
