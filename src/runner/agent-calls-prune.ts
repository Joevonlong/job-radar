import type { McpConfig } from "@/lib/config/schemas/mcp";

interface PruneDependencies {
  now: () => Date;
  readSettings: () => Pick<McpConfig, "audit">;
  prune: (olderThan: Date) => Promise<number>;
  log: (message: string) => void;
}

/** A failed settings read or deletion logs only the maintenance operation, never database or config contents. */
export async function pruneAgentCallsOnce(deps: PruneDependencies): Promise<void> {
  let settings;
  try {
    settings = deps.readSettings();
  } catch {
    deps.log("agent calls prune settings unreadable");
    return;
  }
  try {
    const deleted = await deps.prune(new Date(deps.now().getTime() - settings.audit.retention_days * 86_400_000));
    if (deleted > 0) deps.log(`pruned ${deleted} agent calls`);
  } catch {
    deps.log("agent calls prune failed");
  }
}
