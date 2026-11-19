import type { SyncEntityKind } from "./sync-sources";

export interface ChangePosition {
  tx: string;
  seq: string;
}

export interface SyncEntityKey {
  jobId: number;
  kind: SyncEntityKind;
}

export interface ChangesPosition {
  consumed: ChangePosition;
  active: { row: ChangePosition; after: SyncEntityKey } | null;
}

export interface SnapshotPosition {
  start: ChangePosition;
  after: SyncEntityKey | null;
}

export function compareChangePositions(left: ChangePosition, right: ChangePosition): number {
  const a = BigInt(left.tx), b = BigInt(right.tx);
  if (a !== b) return a < b ? -1 : 1;
  const x = BigInt(left.seq), y = BigInt(right.seq);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function compareSyncEntityKeys(left: SyncEntityKey, right: SyncEntityKey): number {
  if (left.jobId !== right.jobId) return left.jobId - right.jobId;
  return left.kind === right.kind ? 0 : left.kind < right.kind ? -1 : 1;
}
