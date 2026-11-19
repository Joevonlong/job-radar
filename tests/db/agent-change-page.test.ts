import { describe, expect, it } from "vitest";

import { applicationSyncSelection } from "@/lib/capabilities/sync/list-application-changes";
import { syncSelection } from "@/lib/capabilities/sync/scope";
import { checkAgentChangeRetention, scanAgentChangePage } from "@/lib/db/repos/agent-change-page";
import type { AgentChangeRow } from "@/lib/db/repos/agent-changes";
import { compareChangePositions, compareSyncEntityKeys, type ChangesPosition, type SyncEntityKey } from "@/lib/db/sync-position";
import { SYNC_BLOCKS, SYNC_REMOVED_BITS } from "@/lib/db/sync-sources";

const at = new Date("2026-04-05T12:00:00Z");
const later = new Date("2026-04-05T12:01:00Z");
const start: ChangesPosition = { consumed: { tx: "100", seq: "0" }, active: null };
const row = (seq: string, jobId: number, stamp = at): AgentChangeRow => ({
  tx: "101", seq, at: stamp, keyKind: "job", key: String(jobId), blocks: 1, removed: 0,
});
const key = (jobId: number, kind: SyncEntityKey["kind"] = "job"): SyncEntityKey => ({ jobId, kind });
const bit = (block: keyof typeof SYNC_BLOCKS) => 1 << SYNC_BLOCKS[block].bit;

function scan(rows: AgentChangeRow[], limit: number, position = start, keys = (change: AgentChangeRow) => [key(Number(change.key))]) {
  return scanAgentChangePage({
    position, xmin: "200", limit,
    readRows: async (after, chunk) => rows.filter((change) => compareChangePositions(change, after) > 0).slice(0, chunk),
    expand: (change, after) => keys(change).filter((entity) => after === null || compareSyncEntityKeys(entity, after) > 0),
  });
}

describe("sync log paging", () => {
  it("compares transaction IDs first and keeps precision above the JS safe integer range", () => {
    const position = { tx: "9007199254740992", seq: "9007199254740993" };
    expect(compareChangePositions(position, { tx: "9007199254740993", seq: "0" })).toBe(-1);
    expect(compareChangePositions(position, { tx: position.tx, seq: "9007199254740992" })).toBe(1);
    expect(compareChangePositions(position, { ...position })).toBe(0);
  });

  it("exhausts raw rows after deduplication and reports the newest consumed timestamp", async () => {
    const result = await scan([row("1", 4, later), row("2", 4), row("3", 8)], 2);
    expect(result).toEqual({
      entities: [{ ...key(4), changedAt: later, removed: false }, { ...key(8), changedAt: at, removed: false }],
      position: { consumed: { tx: "200", seq: "0" }, active: null },
      hasMore: false,
    });
  });

  it("advances past duplicates and preserves the active job and kind until the row is complete", async () => {
    const rows = [row("1", 1), { ...row("2", 2, later), removed: 1 << SYNC_REMOVED_BITS.favorite }, row("3", 4)];
    const keys = (change: AgentChangeRow) => change.seq === "2"
      ? [key(1), key(2, "application"), key(2, "favorite"), key(3)]
      : [key(Number(change.key))];
    const first = await scan(rows, 2, start, keys);
    expect(first.entities).toEqual([{ ...key(1), changedAt: later, removed: false }, { ...key(2, "application"), changedAt: later, removed: false }]);
    expect(first.position).toEqual({ consumed: { tx: "101", seq: "1" }, active: { row: { tx: "101", seq: "2" }, after: key(2, "application") } });

    const second = await scan(rows, 2, first.position, keys);
    expect(second.entities).toEqual([{ ...key(2, "favorite"), changedAt: later, removed: true }, { ...key(3), changedAt: later, removed: false }]);
    expect(second.position).toEqual({ consumed: { tx: "101", seq: "2" }, active: null });
    expect(second.hasMore).toBe(true);
    const last = await scan(rows, 2, second.position, keys);
    expect(last.entities.map(({ jobId }) => jobId)).toEqual([4]);
    expect(last.hasMore).toBe(false);
  });

  it("pages a shared row by job ID and resumes between an application and a favorite", async () => {
    const selected = applicationSyncSelection(new Set(["tracking:read"]));
    const shared = { ...row("1", 1), keyKind: "company" as const, blocks: bit("job") | bit("app") | bit("fav") };
    const keys = (change: AgentChangeRow) => [4, 8].flatMap((id) => selected.kindsFor(change.blocks).map((kind) => key(id, kind)));
    const expected = [key(4, "application"), key(4, "favorite"), key(8, "application"), key(8, "favorite")];
    const first = await scan([shared], 1, start, keys);
    expect(first.entities).toEqual([{ ...expected[0], changedAt: at, removed: false }]);
    expect(first.position).toEqual({ consumed: start.consumed, active: { row: { tx: shared.tx, seq: shared.seq }, after: expected[0] } });

    let position = first.position;
    for (const [index, item] of expected.slice(1).entries()) {
      const page = await scan([shared], 1, position, keys);
      expect(page.entities).toEqual([{ ...item, changedAt: at, removed: false }]);
      expect(page.hasMore).toBe(index < expected.length - 2);
      position = page.position;
    }
    expect(position).toEqual({ consumed: { tx: "200", seq: "0" }, active: null });
  });

  it("rejects pruned snapshot origins and active rows but accepts an already consumed boundary", async () => {
    const boundary = { tx: "101", seq: "0" };
    expect(() => checkAgentChangeRetention(boundary, { phase: "snapshot", position: { start: boundary, after: null } })).toThrow();
    expect(() => checkAgentChangeRetention(boundary, { phase: "changes", position: { consumed: boundary, active: null } })).not.toThrow();
    expect(() => checkAgentChangeRetention(boundary, { phase: "changes", position: start })).toThrow();
    await expect(scan([row("2", 2)], 1, { ...start, active: { row: { tx: "101", seq: "1" }, after: key(1) } })).rejects.toThrow();
  });
});

describe("sync field scopes", () => {
  it("normalizes selected blocks and excludes unselected, forbidden and unrelated blocks and permissions", () => {
    const selected = syncSelection({
      tool: "list_job_changes", permission: "jobs:read", kinds: ["job"],
      blocks: ["tracking", "job", "salary", "tracking", "app", "match"],
      permissions: new Set(["jobs:read", "tracking:read", "notes:read", "ops:read"]),
    });
    expect(selected.scope.blocks).toEqual(["app", "job", "match", "salary", "tracking"]);
    expect(selected.scope.permissions).toEqual(["jobs:read", "tracking:read"]);
    expect(selected.unpermitted).toEqual(["app", "match"]);
    expect(selected.mask).toBe(bit("job") | bit("salary") | bit("tracking"));
    expect(selected.kindsFor(bit("match") | bit("notes") | bit("app") | bit("fav"))).toEqual([]);
    expect(selected.kindsFor(bit("tracking") | bit("app"))).toEqual(["job"]);
  });

  it("partitions intersections by kind after applying the selected permission mask", () => {
    const selected = applicationSyncSelection(new Set(["tracking:read", "notes:read", "jobs:read"]), ["app", "fav.notes"]);
    expect(selected.scope.permissions).toEqual(["notes:read", "tracking:read"]);
    expect(selected.mask).toBe(bit("app") | bit("fav.notes"));
    expect(selected.kindsFor(bit("notes") | bit("fav.notes"))).toEqual(["favorite"]);
    expect(selected.kindsFor(bit("app") | bit("fav.notes") | bit("app.notes"))).toEqual(["application", "favorite"]);
    expect(selected.kindsFor(bit("job") | bit("tracking") | bit("app.notes") | bit("fav"))).toEqual([]);
  });

  it("defaults to the application and favorite readers' granted blocks", () => {
    const base = applicationSyncSelection(new Set(["tracking:read", "jobs:read"]));
    expect(base.scope.blocks).toEqual(["app", "fav"]);
    expect(base.mask).toBe(bit("app") | bit("fav"));
    expect(base.kindsFor(bit("app.notes") | bit("fav.notes"))).toEqual([]);
    const notes = applicationSyncSelection(new Set(["tracking:read", "notes:read"]));
    expect(notes.scope.blocks).toEqual(["app", "app.notes", "fav", "fav.notes"]);
    expect(notes.mask).toBe(base.mask | bit("app.notes") | bit("fav.notes"));
  });
});
