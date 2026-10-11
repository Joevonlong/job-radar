import type { Db } from "@/lib/db/client";
import { upsertBoardCandidates, type BoardCandidateInput } from "@/lib/db/repos/board-candidates";
import { listRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

/** What the discovery channel keeps between runs. */
export interface DiscoveryStore {
  /** Record boards seen; returns how many are new to the candidate table. */
  upsert(items: readonly BoardCandidateInput[]): Promise<number>;
  /** When the last discovery run finished (database clock); null before the first one. */
  lastRunAt(): Promise<Date | null>;
  markRun(): Promise<void>;
}

/** `provider` is the discovery channel id: each one keeps its own run marker. */
export function createDbDiscoveryStore(db: Db, provider: string): DiscoveryStore {
  const LAST_RUN_KEY = `discovery:${provider}:last_run`;
  return {
    upsert: (items) => upsertBoardCandidates(db, items),
    async lastRunAt() {
      const [row] = await listRuntimeState(db, LAST_RUN_KEY);
      return row?.key === LAST_RUN_KEY ? row.updatedAt : null;
    },
    markRun: () => setRuntimeState(db, LAST_RUN_KEY, { ok: true }),
  };
}

export function createMemoryDiscoveryStore(): DiscoveryStore & { candidates: Map<string, BoardCandidateInput>; runs: number; last: Date | null } {
  const candidates = new Map<string, BoardCandidateInput>();
  const store = {
    candidates,
    runs: 0,
    last: null as Date | null,
    async upsert(items: readonly BoardCandidateInput[]) {
      let fresh = 0;
      for (const item of items) {
        const key = `${item.ats}:${item.token}`;
        if (!candidates.has(key)) fresh += 1;
        candidates.set(key, item);
      }
      return fresh;
    },
    async lastRunAt() {
      return store.last;
    },
    async markRun() {
      store.runs += 1;
      store.last = new Date();
    },
  };
  return store;
}
