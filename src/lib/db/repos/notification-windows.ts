import { inArray, like, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../client";
import { runtimeState } from "../schema";
import { recordNotification, type NotificationInput } from "./notifications";

const PREFIX = "notify:window:";
const windowSchema = z.object({
  cycleId: z.number().int().positive(),
  requestId: z.number().int().positive().optional(),
  since: z.iso.datetime(),
  startedAt: z.iso.datetime(),
});
type PendingWindow = z.infer<typeof windowSchema>;

export interface DigestWindow {
  since: Date;
  startedAt: Date;
  windows: PendingWindow[];
}

/**
 * Checkpoint before any send or deferral. These records are delivery work, never queue entries: later notify runs
 * inherit every outstanding window, even after candidate_window_hours or a process restart.
 */
export async function retainNotificationWindow(db: Db, input: { cycleId: number; requestId?: number; since: Date; startedAt: Date }): Promise<DigestWindow> {
  const value: PendingWindow = { ...input, since: input.since.toISOString(), startedAt: input.startedAt.toISOString() };
  await db.insert(runtimeState).values({ key: `${PREFIX}${input.cycleId}`, value }).onConflictDoNothing();
  const rows = await db.select({ value: runtimeState.value }).from(runtimeState).where(like(runtimeState.key, `${PREFIX}%`));
  const windows = rows.map((row) => windowSchema.parse(row.value));
  return {
    since: new Date(Math.min(...windows.map((window) => new Date(window.since).getTime()))),
    startedAt: new Date(Math.min(...windows.map((window) => new Date(window.startedAt).getTime()))),
    windows,
  };
}

/** A recorded successor delivery also settles its predecessors if their worker stopped before saving the outcome. */
export async function hasDeliveredNotificationWindow(db: Db, cycleId: number): Promise<boolean> {
  const [row] = await db.execute<{ delivered: boolean }>(sql`
    select exists (
      select 1 from notifications
      where kind = 'cycle_summary' and sent_at is not null
        and (cycle_id = ${cycleId} or payload_json -> 'window' -> 'cycleIds' @> ${JSON.stringify([cycleId])}::jsonb)
    ) as delivered
  `);
  return row?.delivered ?? false;
}

/**
 * The delivery receipt, window retirement and predecessor outcomes commit together. Retire only the windows actually
 * included in this digest's snapshot, so a newly created window cannot be accidentally acknowledged.
 */
export async function recordDigestDelivery(db: Db, digest: DigestWindow, input: NotificationInput & { cycleId: number; payload: Record<string, unknown> }): Promise<void> {
  await db.transaction(async (tx) => {
    await recordNotification(tx, {
      ...input,
      payload: { ...input.payload, window: { since: digest.since.toISOString(), startedAt: digest.startedAt.toISOString(), cycleIds: digest.windows.map((window) => window.cycleId) } },
    });
    await tx.delete(runtimeState).where(inArray(runtimeState.key, digest.windows.map((window) => `${PREFIX}${window.cycleId}`)));
    const predecessors = digest.windows.filter((window) => window.cycleId !== input.cycleId);
    const requestIds = digest.windows.flatMap((window) => window.requestId === undefined ? [] : [window.requestId]);
    if (requestIds.length > 0) {
      await tx.execute(sql`
        update control_requests
        set result = (coalesce(result, '{}'::jsonb) - 'notifyRetryAt') || jsonb_build_object(
              'notify', coalesce(result -> 'notify', '{}'::jsonb) || jsonb_build_object('pending', false, 'deliveredByCycleId', ${input.cycleId}::int)
            ),
            status = case when status = 'pending' and result ? 'notifyRetryAt' then 'done'::control_request_status else status end,
            finished_at = case when status = 'pending' and result ? 'notifyRetryAt' then now() else finished_at end
        where id in (${sql.join(requestIds.map((id) => sql`${id}`), sql`, `)})
      `);
    }
    if (predecessors.length > 0) {
      await tx.execute(sql`
        update cycles
        set summary_json = jsonb_set(summary_json, '{steps}', (
          select jsonb_agg(case when step ->> 'name' = 'notify'
            then jsonb_set(step, '{result}', (coalesce(step -> 'result', '{}'::jsonb) - 'retry') || jsonb_build_object('deliveredByCycleId', ${input.cycleId}::int))
            else step end order by position)
          from jsonb_array_elements(summary_json -> 'steps') with ordinality as steps(step, position)
        ))
        where id in (${sql.join(predecessors.map((window) => sql`${window.cycleId}`), sql`, `)})
          and jsonb_typeof(summary_json -> 'steps') = 'array'
          and jsonb_array_length(summary_json -> 'steps') > 0
      `);
    }
  });
}
