import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { expect, inject, it } from "vitest";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

it("upgrades audit rows through budgets and the new outcome, preserving data and supporting a repeated SQL file", async () => {
  const address = new URL(inject("testDatabaseUrl"));
  const name = `${address.pathname.slice(1)}_audit_upgrade`;
  if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected disposable database");
  address.pathname = "/postgres";
  const admin = postgres(address.toString(), { max: 1, onnotice: () => {} });
  address.pathname = `/${name}`;
  const connection = createConnection(address.toString(), { max: 1 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-call-upgrade-"));
  const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };
  try {
    await admin.unsafe(`create database "${name}"`);
    fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
    const journalFile = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { idx: number; tag: string }[] };
    const through = async (last: number) => {
      fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= last) }));
      await runMigrations({ url: address.toString(), migrationsFolder: directory, currentScoresBackfill: backfill });
    };
    await through(59);
    for (const outcome of ["ok", "not_permitted", "invalid_input", "error"]) {
      await connection.sql`insert into agent_calls (caller, transport, capability, outcome, error_category, returned_count, duration_ms)
        values ('stdio', 'stdio', 'search_jobs', ${outcome}, ${outcome === "error" ? "database" : null}, 3, 7)`;
    }
    const before = await connection.sql`select * from agent_calls order by id`;
    await through(60);
    expect(await connection.sql`select * from agent_calls order by id`).toEqual(before);
    await through(61);
    expect(await connection.sql`select * from agent_calls order by id`).toEqual(before);
    await connection.sql`insert into agent_calls (caller, transport, capability, outcome, returned_count, duration_ms)
      values ('stdio', 'stdio', 'score_jobs', 'over_budget', 0, 4)`;
    await expect(connection.sql`insert into agent_calls (caller, transport, capability, outcome, returned_count, duration_ms)
      values ('stdio', 'stdio', 'score_jobs', 'unknown_outcome', 0, 4)`).rejects.toMatchObject({ code: "23514" });
    const sqlFile = fs.readFileSync(path.resolve("drizzle/0061_agent_call_over_budget.sql"), "utf8");
    for (const statement of sqlFile.split("--> statement-breakpoint")) await connection.sql.unsafe(statement);
    expect(await connection.sql`select * from agent_calls where outcome <> 'over_budget' order by id`).toEqual(before);
    expect((await connection.sql`select outcome from agent_calls where outcome = 'over_budget'`)).toEqual([{ outcome: "over_budget" }]);
  } finally {
    await connection.sql.end();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
