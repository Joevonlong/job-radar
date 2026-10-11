import type { Db } from "@/lib/db/client";
import {
  getAtsBoard,
  recordAtsBoardCheck,
  touchRawPostings,
  type AtsBoardKey,
  type AtsBoardUpdate,
} from "@/lib/db/repos/ats-boards";

/** What the channel remembers of a board between cycles. */
export interface AtsBoardState {
  etag: string | null;
  filterFingerprint: string | null;
  /** External ids stored from the response `etag` belongs to. */
  externalIds: string[];
}

export interface AtsBoardStore {
  load(key: AtsBoardKey): Promise<AtsBoardState | null>;
  record(key: AtsBoardKey, update: AtsBoardUpdate): Promise<void>;
  /** Mark the stored raw postings with these ids as seen now; returns how many exist. */
  touch(channelId: string, externalIds: readonly string[]): Promise<number>;
}

/** Store backed by `ats_boards` and `raw_postings`. */
export function createDbAtsBoardStore(db: Db): AtsBoardStore {
  return {
    async load(key) {
      const row = await getAtsBoard(db, key);
      return row ? { etag: row.etag, filterFingerprint: row.filterFingerprint, externalIds: row.externalIds } : null;
    },
    record: (key, update) => recordAtsBoardCheck(db, key, update),
    touch: (channelId, externalIds) => touchRawPostings(db, { channelId, externalIds }),
  };
}

/** In-memory store for unit tests. */
export function createMemoryAtsBoardStore(): AtsBoardStore & {
  states: Map<string, AtsBoardState>;
  checks: Array<{ key: AtsBoardKey; update: AtsBoardUpdate }>;
  /** External ids that count as stored in raw_postings (for `touch`). */
  stored: Set<string>;
  touched: string[][];
} {
  const states = new Map<string, AtsBoardState>();
  const checks: Array<{ key: AtsBoardKey; update: AtsBoardUpdate }> = [];
  const stored = new Set<string>();
  const touched: string[][] = [];
  const id = (key: AtsBoardKey): string => `${key.ats}:${key.token}`;
  return {
    states,
    checks,
    stored,
    touched,
    async load(key) {
      return states.get(id(key)) ?? null;
    },
    async record(key, update) {
      checks.push({ key, update });
      if (update.status === "ok") {
        states.set(id(key), {
          etag: update.etag ?? null,
          filterFingerprint: update.filterFingerprint ?? null,
          externalIds: [...(update.externalIds ?? [])],
        });
        for (const externalId of update.externalIds ?? []) stored.add(externalId);
      }
    },
    async touch(_channelId, externalIds) {
      touched.push([...externalIds]);
      return externalIds.filter((e) => stored.has(e)).length;
    },
  };
}
