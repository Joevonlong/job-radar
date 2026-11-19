import type { McpConfig } from "@/lib/config/schemas/mcp";

const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

interface PruneDependencies {
  now: () => number;
  loadConfig: () => Pick<McpConfig, "sync">;
  prune: (retentionDays: number) => Promise<number>;
  log: (message: string) => void;
}

/** Run daily maintenance off the heartbeat loop without overlapping an in-flight prune. */
export function createAgentChangesPruner(deps: PruneDependencies) {
  let lastRunAt: number | null = null;
  let pending: Promise<void> | undefined;

  async function runPrune(): Promise<void> {
    try {
      const deleted = await deps.prune(deps.loadConfig().sync.retention_days);
      if (deleted > 0) deps.log(`pruned ${deleted} agent changes`);
    } catch {
      deps.log("agent change log prune failed");
    }
  }

  return {
    tick: (): Promise<void> => {
      if (pending) return pending;
      const now = deps.now();
      if (lastRunAt !== null && now - lastRunAt < PRUNE_EVERY_MS) return Promise.resolve();
      lastRunAt = now;
      pending = runPrune().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
