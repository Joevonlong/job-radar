import type { Db } from "@/lib/db/client";
import {
  getAtsBoard,
  recordAtsBoardCheck,
  touchRawPostings,
  type AtsBoardKey,
  type AtsBoardUpdate,
} from "@/lib/db/repos/ats-boards";

/** Last complete-list state and latest detail retries remembered between cycles. */
export interface AtsBoardState {
  etag: string | null;
  filterFingerprint: string | null;
  /** Ids from the last complete list: handed over or still listed and already stored beyond the cap or with missing details. */
  externalIds: string[];
  /** Failed or skipped details from the latest content read, including a short or failed list; requested last next time. */
  detailRetryIds: string[];
}

export interface AtsBoardStore {
  load(key: AtsBoardKey): Promise<AtsBoardState | null>;
  record(key: AtsBoardKey, update: AtsBoardUpdate): Promise<void>;
  /** Mark the stored raw postings with these ids as seen now; returns the external ids that exist. */
  touch(channelId: string, externalIds: readonly string[]): Promise<string[]>;
}

/** Store backed by `ats_boards` and `raw_postings`. */
export function createDbAtsBoardStore(db: Db): AtsBoardStore {
  return {
    async load(key) {
      const row = await getAtsBoard(db, key);
      return row ? { etag: row.etag, filterFingerprint: row.filterFingerprint, externalIds: row.externalIds, detailRetryIds: row.detailRetryIds } : null;
    },
    record: (key, update) => recordAtsBoardCheck(db, key, update),
    touch: (channelId, externalIds) => touchRawPostings(db, { channelId, externalIds }),
  };
}

/** In-memory store for unit tests; partial reads can update retries only on an existing complete-list state. */
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
          detailRetryIds: [...(update.detailRetryIds ?? [])],
        });
        for (const externalId of update.externalIds ?? []) stored.add(externalId);
      } else if ((update.status === "short" || update.status === "error") && update.detailRetryIds !== undefined) {
        const state = states.get(id(key));
        if (state) states.set(id(key), { ...state, detailRetryIds: [...update.detailRetryIds] });
      }
    },
    async touch(_channelId, externalIds) {
      touched.push([...externalIds]);
      return externalIds.filter((e) => stored.has(e));
    },
  };
}
