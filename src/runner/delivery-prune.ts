import type { DeliveryAuditConfig } from "@/lib/config/schemas/delivery-audit";
import type { CycleSummary } from "@/lib/cycle/run-cycle";

interface PruneDependencies {
  now: () => Date;
  loadConfig: () => Pick<DeliveryAuditConfig, "retention" | "prune">;
  tablesReady: () => Promise<boolean>;
  payloadBytes: () => Promise<number>;
  prune: (input: { olderThan: Date; batchSize: number; statementTimeoutMs: number }) => Promise<number>;
  log: (message: string) => void;
}

/** Database operations are injected so maintenance can be exercised without a connection. */
export function createDeliveryPruner(deps: PruneDependencies) {
  let lastRunAt: number | null = null;
  let pending = Promise.resolve();

  function enqueue(early: boolean): Promise<void> {
    pending = pending.then(async () => {
      try {
        const config = deps.loadConfig();
        const now = deps.now().getTime();
        if (!early && lastRunAt !== null && now - lastRunAt < config.prune.every_minutes * 60_000) return;
        if (!(await deps.tablesReady())) return;
        if (early && await deps.payloadBytes() <= config.retention.warn_bytes) return;
        lastRunAt = now;
        const deleted = await deps.prune({
          olderThan: new Date(now - config.retention.days * 86_400_000),
          batchSize: config.prune.batch_size,
          statementTimeoutMs: config.prune.statement_timeout_ms,
        });
        if (deleted > 0) deps.log(`pruned ${deleted} delivery items`);
      } catch {
        // Database errors can contain receipt values; maintenance logs only the operation.
        deps.log("delivery prune failed");
      }
    });
    return pending;
  }

  return {
    tick: () => enqueue(false),
    afterCollect: () => enqueue(true),
    afterCycle: (summary: Pick<CycleSummary, "dryRun"> & { steps: ReadonlyArray<Pick<CycleSummary["steps"][number], "name" | "status">> }): void => {
      if (!summary.dryRun && summary.steps.some((step) => step.name === "collect" && step.status !== "skipped")) {
        void enqueue(true).catch(() => deps.log("delivery prune failed"));
      }
    },
  };
}
