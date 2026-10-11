import type { Db } from "@/lib/db/client";
import {
  addMonthUsage,
  getChannelRows,
  getMonthUsage,
  saveCircuitState,
  upsertChannelRows,
  type ChannelRowInput,
  type MonthUsage,
} from "@/lib/db/repos/channels";

import { CLOSED_CIRCUIT, type CircuitSnapshot, type CircuitStore } from "./circuit";

/** Persistent per-channel state the framework needs: breaker state, monthly usage, channel rows. */
export interface ChannelStateStore extends CircuitStore {
  upsertChannels(rows: readonly ChannelRowInput[]): Promise<void>;
  loadUsage(month: string): Promise<Map<string, MonthUsage>>;
  addUsage(channelId: string, month: string, delta: MonthUsage): Promise<void>;
}

/** Store backed by the `channels` table. */
export function createDbStateStore(db: Db): ChannelStateStore {
  return {
    upsertChannels: (rows) => upsertChannelRows(db, rows),
    async loadCircuit(channelId) {
      const [row] = await getChannelRows(db, [channelId]);
      if (!row) return { ...CLOSED_CIRCUIT };
      return {
        state: row.circuitState,
        consecutiveFailures: row.consecutiveFailures,
        openUntil: row.circuitOpenUntil,
        lastErrorCode: row.lastErrorCode,
        lastSuccessAt: row.lastSuccessAt,
      };
    },
    saveCircuit: (channelId, snapshot, health) =>
      saveCircuitState(db, channelId, {
        circuitState: snapshot.state,
        consecutiveFailures: snapshot.consecutiveFailures,
        circuitOpenUntil: snapshot.openUntil,
        lastErrorCode: snapshot.lastErrorCode,
        lastSuccessAt: snapshot.lastSuccessAt,
        health,
      }),
    loadUsage: (month) => getMonthUsage(db, month),
    addUsage: (channelId, month, delta) => addMonthUsage(db, channelId, month, delta),
  };
}

/** In-memory store: dry runs (no writes) and unit tests. Optionally seeded from another store's reads. */
export function createMemoryStateStore(base: ChannelStateStore | null = null): ChannelStateStore {
  const circuits = new Map<string, CircuitSnapshot>();
  const usage = new Map<string, Map<string, MonthUsage>>(); // month -> channel -> delta recorded here
  return {
    async upsertChannels() {},
    async loadCircuit(channelId) {
      return circuits.get(channelId) ?? (base ? await base.loadCircuit(channelId) : { ...CLOSED_CIRCUIT });
    },
    async saveCircuit(channelId: string, snapshot: CircuitSnapshot) {
      circuits.set(channelId, snapshot);
    },
    async loadUsage(month) {
      const merged = new Map<string, MonthUsage>();
      for (const [id, u] of base ? await base.loadUsage(month) : []) merged.set(id, { ...u });
      for (const [id, delta] of usage.get(month) ?? []) {
        const current = merged.get(id) ?? { records: 0, usd: 0 };
        merged.set(id, { records: current.records + delta.records, usd: current.usd + delta.usd });
      }
      return merged;
    },
    async addUsage(channelId, month, delta) {
      const forMonth = usage.get(month) ?? new Map<string, MonthUsage>();
      const current = forMonth.get(channelId) ?? { records: 0, usd: 0 };
      forMonth.set(channelId, { records: current.records + delta.records, usd: current.usd + delta.usd });
      usage.set(month, forMonth);
    },
  };
}
