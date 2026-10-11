import { randomBytes } from "node:crypto";

import postgres from "postgres";
import type { TestProject } from "vitest/node";

import { runMigrations } from "../../src/lib/db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

// Host-side address of the compose `db` service; override with DATABASE_URL (e.g. in CI).
const DEFAULT_ADMIN_URL = "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = new URL(process.env.DATABASE_URL || DEFAULT_ADMIN_URL);
  const dbName = `jobradar_test_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${dbName}"`);
  } catch (error) {
    await admin.end({ timeout: 2 });
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Cannot create a test database (is Postgres up and DATABASE_URL correct? e.g. \`pnpm stack:up\`): ${reason}`,
    );
  }

  const testUrl = new URL(adminUrl.toString());
  testUrl.pathname = `/${dbName}`;
  // Migrations once for the whole run: the per-file reset (setup.ts) truncates tables that must already exist.
  await runMigrations({ url: testUrl.toString() });
  project.provide("testDatabaseUrl", testUrl.toString());

  return async () => {
    try {
      await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  };
}
