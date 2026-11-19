import { eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { agentChangeLog } from "../schema";

export type AgentChangeLogIdentity = Pick<typeof agentChangeLog.$inferSelect, "logId" | "systemIdentifier" | "databaseOid">;

export type AgentChangeIdentityCheck =
  | { status: "match" | "mismatch"; identity: AgentChangeLogIdentity }
  | { status: "unavailable"; reason: "schema_missing" | "identity_unreadable" | "identity_missing" };

const identityColumns = {
  logId: agentChangeLog.logId,
  systemIdentifier: agentChangeLog.systemIdentifier,
  databaseOid: agentChangeLog.databaseOid,
};

export async function readAgentChangeLogIdentity(db: Executor): Promise<AgentChangeLogIdentity | null> {
  const [identity] = await db.select(identityColumns).from(agentChangeLog).where(eq(agentChangeLog.singleton, true));
  return identity ?? null;
}

/** Check the identity without aborting the caller's read snapshot if the schema is absent or access was revoked. */
export async function checkAgentChangeIdentity(db: Executor): Promise<AgentChangeIdentityCheck> {
  const [access] = await db.execute<{ installed: boolean; can_read_identity: boolean | null }>(sql`
    select to_regclass('public.agent_change_log') is not null and to_regclass('public.agent_changes') is not null as installed,
      has_table_privilege(to_regclass('public.agent_change_log')::oid, 'SELECT')
        and has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE') as can_read_identity
  `);
  if (!access?.installed) return { status: "unavailable", reason: "schema_missing" };
  if (!access.can_read_identity) return { status: "unavailable", reason: "identity_unreadable" };

  const [row] = await db.select({
    ...identityColumns,
    matches: sql<boolean | null>`
      ${agentChangeLog.systemIdentifier} = (select system_identifier from pg_catalog.pg_control_system())
      and ${agentChangeLog.databaseOid} = (select oid from pg_catalog.pg_database where datname = current_database())
    `,
  }).from(agentChangeLog).where(eq(agentChangeLog.singleton, true));
  if (!row) return { status: "unavailable", reason: "identity_missing" };
  const { matches, ...identity } = row;
  if (matches === null) return { status: "unavailable", reason: "identity_unreadable" };
  return { status: matches ? "match" : "mismatch", identity };
}

/** The reset's lock also keeps the returned log ID from racing with another reset. */
export async function resetAgentChanges(db: Executor): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select public.agent_changes_reset()`);
    const identity = await readAgentChangeLogIdentity(tx);
    if (!identity) throw new Error("agent change log identity missing after reset");
    return identity.logId;
  });
}

async function lockAgentChangeLog(db: Executor): Promise<string | null> {
  const [row] = await db.select({ logId: agentChangeLog.logId }).from(agentChangeLog)
    .where(eq(agentChangeLog.singleton, true)).for("update");
  return row?.logId ?? null;
}

/** Take the snapshot before allocating this transaction's ID, so concurrent commits cannot look like future rows. */
async function hasFutureAgentChanges(db: Executor): Promise<boolean> {
  const [row] = await db.execute<{ future: boolean }>(sql`
    select coalesce(
      (select tx from public.agent_changes order by tx desc limit 1) >= pg_current_xact_id(), false
    ) as future
  `);
  return row?.future === true;
}

/** Check after migrations, including on restarts. A reset already done by another session supersedes this check. */
export async function resetAgentChangesIfNeeded(db: Db): Promise<boolean> {
  return db.transaction(async (tx) => {
    const check = await checkAgentChangeIdentity(tx);
    if (check.status === "unavailable") {
      if (check.reason !== "identity_missing") return false;
      await tx.execute(sql`lock table public.agent_change_log in exclusive mode`);
      if (await readAgentChangeLogIdentity(tx)) return false;
    } else {
      if (check.status === "match" && !(await hasFutureAgentChanges(tx))) return false;
      if ((await lockAgentChangeLog(tx)) !== check.identity.logId) return false;
    }
    await resetAgentChanges(tx);
    return true;
  }, { isolationLevel: "read committed" });
}

/** Keep the pruning position monotonic even when an older transaction writes a more recent timestamp. */
export async function pruneAgentChanges(db: Executor, retentionDays: number): Promise<number> {
  return db.transaction(async (tx) => {
    if (!(await lockAgentChangeLog(tx))) return 0;

    const [row] = await tx.execute<{ deleted: string }>(sql`
      with deleted as (
        delete from public.agent_changes
        where at < now() - make_interval(days => ${retentionDays})
          and tx < pg_snapshot_xmin(pg_current_snapshot())
        returning tx, seq
      ), latest as (
        select tx, seq from deleted order by tx desc, seq desc limit 1
      ), advanced as (
        update public.agent_change_log as log
        set pruned_through_tx = latest.tx, pruned_through_seq = latest.seq
        from latest
        where log.singleton and (log.pruned_through_tx is null
          or (log.pruned_through_tx, log.pruned_through_seq) < (latest.tx, latest.seq))
      )
      select count(*)::text as deleted from deleted
    `);
    return Number(row?.deleted ?? 0);
  }, { isolationLevel: "read committed" });
}
