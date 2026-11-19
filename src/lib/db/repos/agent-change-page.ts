import { compareChangePositions, type ChangePosition, type ChangesPosition, type SnapshotPosition, type SyncEntityKey } from "../sync-position";
import { SYNC_REMOVED_BITS } from "../sync-sources";
import type { AgentChangeRow } from "./agent-changes";

export class AgentChangesPruned extends Error {}

export function checkAgentChangeRetention(pruned: ChangePosition | null, cursor:
  | { phase: "snapshot"; position: SnapshotPosition }
  | { phase: "changes"; position: ChangesPosition },
): void {
  if (pruned === null) return;
  if (cursor.phase === "snapshot") {
    if (compareChangePositions(pruned, cursor.position.start) >= 0) throw new AgentChangesPruned();
    return;
  }
  const { consumed, active } = cursor.position;
  if (compareChangePositions(pruned, consumed) > 0 ||
    (active !== null && compareChangePositions(pruned, active.row) >= 0)) throw new AgentChangesPruned();
}

interface ChangedEntity extends SyncEntityKey {
  changedAt: Date;
  removed: boolean;
}

interface ChangePage {
  entities: ChangedEntity[];
  position: ChangesPosition;
  hasMore: boolean;
}

/** Consume complete rows until the next distinct entity would overflow the page, retaining the position within a partial row. */
export async function scanAgentChangePage(input: {
  position: ChangesPosition;
  xmin: string;
  limit: number;
  readRows: (after: ChangePosition, limit: number) => Promise<readonly AgentChangeRow[]>;
  expand: (row: AgentChangeRow, after: SyncEntityKey | null) => AsyncIterable<SyncEntityKey> | Iterable<SyncEntityKey>;
}): Promise<ChangePage> {
  let { consumed, active } = input.position;
  const entities = new Map<string, ChangedEntity>();
  const chunk = input.limit + 1;

  for (;;) {
    const rows = await input.readRows(consumed, chunk);
    if (active !== null && (!rows[0] || compareChangePositions(rows[0], active.row) !== 0)) {
      throw new AgentChangesPruned();
    }
    for (const row of rows) {
      const point = { tx: row.tx, seq: row.seq };
      let after = active?.after ?? null;
      for await (const entity of input.expand(row, after)) {
        const id = `${entity.jobId}:${entity.kind}`;
        const previous = entities.get(id);
        if (!previous && entities.size === input.limit) {
          return {
            entities: [...entities.values()],
            position: { consumed, active: after === null ? null : { row: point, after } },
            hasMore: true,
          };
        }
        entities.set(id, {
          ...entity,
          changedAt: previous && previous.changedAt > row.at ? previous.changedAt : row.at,
          removed: (previous?.removed ?? false) || (row.removed & (1 << SYNC_REMOVED_BITS[entity.kind])) !== 0,
        });
        after = entity;
      }
      consumed = point;
      active = null;
    }
    if (rows.length < chunk) return {
      entities: [...entities.values()],
      position: { consumed: { tx: input.xmin, seq: "0" }, active: null },
      hasMore: false,
    };
  }
}
