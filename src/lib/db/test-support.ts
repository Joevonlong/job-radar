/** Database operations used by the identity and cycle recovery integration tests. Never imported by runtime code. */
import { eq, sql } from "drizzle-orm";

import { databaseUrlFor, type Db } from "./client";
import type { Executor } from "./executor";
import * as schema from "./schema";
import { assertTestDatabase } from "./test-guard";

export function databaseTestSupport(db: Db) {
  assertTestDatabase(databaseUrlFor(db), { VITEST: "true" });
  return {
    insertChannels: (rows: Array<typeof schema.channels.$inferInsert>) => db.insert(schema.channels).values(rows),
    insertCompany: (row: typeof schema.companies.$inferInsert) => db.insert(schema.companies).values(row).returning(),
    insertJob: (row: typeof schema.jobs.$inferInsert) => db.insert(schema.jobs).values(row).returning(),
    insertSources: (rows: Array<typeof schema.jobSources.$inferInsert>) => db.insert(schema.jobSources).values(rows),
    jobs: () => db.select().from(schema.jobs).orderBy(schema.jobs.id),
    rawPostings: () => db.select().from(schema.rawPostings).orderBy(schema.rawPostings.id),
    sources: () => db.select().from(schema.jobSources).orderBy(schema.jobSources.id),
    cycles: () => db.select().from(schema.cycles).orderBy(schema.cycles.id),
    cycle: (id: number) => db.select().from(schema.cycles).where(eq(schema.cycles.id, id)),
    scores: () => db.select().from(schema.scores).orderBy(schema.scores.id),
    ping: () => db.execute(sql`select 1`),
    terminateBackend: (pid: number) => db.execute(sql`select pg_terminate_backend(${pid})`),
    async cycleLockWaiters(processId?: number): Promise<number> {
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and not l.granted and l.database = (select oid from pg_database where datname = current_database())
        and (${processId === undefined} or a.application_name like ${`job-radar cycle pid=${processId} %`})`);
      return row?.n ?? 0;
    },
    async pipelineLockWaiters(): Promise<number> {
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and (query like '%raw_postings%' or query like '%job_sources%')`);
      return row?.n ?? 0;
    },
    async applyIdentityMigration(migration: string): Promise<void> {
      await db.transaction(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
      });
    },
    async installFinishFailure(): Promise<void> {
      await db.execute(sql`create sequence fail_cycle_finish_once`);
      await db.execute(sql`create function fail_cycle_finish_once() returns trigger language plpgsql as $$ begin if old.status = 'running' and new.status <> 'running' and nextval('fail_cycle_finish_once') = 1 then raise exception 'test finish failure'; end if; return new; end $$`);
      await db.execute(sql`create trigger fail_cycle_finish_once before update on cycles for each row execute function fail_cycle_finish_once()`);
    },
    async removeFinishFailure(): Promise<void> {
      await db.execute(sql`drop trigger fail_cycle_finish_once on cycles`);
      await db.execute(sql`drop function fail_cycle_finish_once()`);
      await db.execute(sql`drop sequence fail_cycle_finish_once`);
    },
    async installFilterWriteGate(): Promise<void> {
      await db.execute(sql`create function wait_for_filter_write() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(19026, 28673); return new; end $$`);
      await db.execute(sql`create trigger wait_for_filter_write before insert on scores for each row execute function wait_for_filter_write()`);
    },
    async removeFilterWriteGate(): Promise<void> {
      await db.execute(sql`drop trigger wait_for_filter_write on scores`);
      await db.execute(sql`drop function wait_for_filter_write()`);
    },
    async blockedFilterWrites(): Promise<number> {
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database()
        and wait_event = 'advisory' and query like 'insert into "scores"%'`);
      return row?.n ?? 0;
    },
    async holdFilterWrites(entered: () => void, gate: Promise<void>): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(19026, 28673)`);
        entered();
        await gate;
      });
    },
  };
}

export async function lockTestRawPosting(db: Executor, rawPostingId: number): Promise<void> {
  await db.select().from(schema.rawPostings).where(eq(schema.rawPostings.id, rawPostingId)).for("update");
}
