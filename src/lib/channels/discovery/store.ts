import { z } from "zod";

import type { Db } from "@/lib/db/client";
import { upsertBoardCandidates, type BoardCandidateInput } from "@/lib/db/repos/board-candidates";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

const turnsSchema = z.strictObject({ version: z.literal(1), turns: z.record(z.string(), z.iso.datetime()) });

/** What the discovery channel keeps between runs. */
export interface DiscoveryStore {
  /** Record boards seen; returns how many are new to the candidate table. */
  upsert(items: readonly BoardCandidateInput[]): Promise<number>;
  /** When the last discovery run finished (database clock); null before the first one. */
  lastRunAt(): Promise<Date | null>;
  markRun(): Promise<void>;
  lastTurns(): Promise<Map<string, Date>>;
  saveTurns(turns: ReadonlyMap<string, Date>): Promise<void>;
}

/** `provider` is the discovery channel id: each one keeps its own run marker and query turns. */
export function createDbDiscoveryStore(db: Db, provider: string): DiscoveryStore {
  const LAST_RUN_KEY = `discovery:${provider}:last_run`;
  const TURNS_KEY = `discovery:${provider}:turns`;
  return {
    upsert: (items) => upsertBoardCandidates(db, items),
    async lastRunAt() {
      const row = await getRuntimeState(db, LAST_RUN_KEY);
      return row?.updatedAt ?? null;
    },
    markRun: () => setRuntimeState(db, LAST_RUN_KEY, { ok: true }),
    async lastTurns() {
      const row = await getRuntimeState(db, TURNS_KEY);
      const parsed = turnsSchema.safeParse(row?.value);
      return parsed.success ? new Map(Object.entries(parsed.data.turns).map(([id, at]) => [id, new Date(at)])) : new Map();
    },
    saveTurns: (turns) => setRuntimeState(db, TURNS_KEY, {
      version: 1,
      turns: Object.fromEntries([...turns].map(([id, at]) => [id, at.toISOString()])),
    }),
  };
}

export function createMemoryDiscoveryStore(): DiscoveryStore & { candidates: Map<string, BoardCandidateInput>; runs: number; last: Date | null; turns: Map<string, Date>; turnReads: number; turnWrites: number } {
  const candidates = new Map<string, BoardCandidateInput>();
  const store = {
    candidates,
    runs: 0,
    last: null as Date | null,
    turns: new Map<string, Date>(),
    turnReads: 0,
    turnWrites: 0,
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
    async lastTurns() {
      store.turnReads += 1;
      return new Map(store.turns);
    },
    async saveTurns(turns: ReadonlyMap<string, Date>) {
      store.turnWrites += 1;
      store.turns = new Map(turns);
    },
  };
  return store;
}
