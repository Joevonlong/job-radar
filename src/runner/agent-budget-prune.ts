import type { McpConfig } from "@/lib/config/schemas/mcp";
import { addDays, dayInZone } from "@/lib/insights/range";

export async function pruneAgentBudgetOnce(deps: {
  now(): Date;
  readSettings(): Pick<McpConfig, "audit">;
  timeZone(): string;
  prune(beforeDay: string): Promise<number>;
  log(message: string): void;
}): Promise<void> {
  try {
    const retention = deps.readSettings().audit.retention_days;
    const beforeDay = addDays(dayInZone(deps.now(), deps.timeZone()), -retention);
    const pruned = await deps.prune(beforeDay);
    if (pruned > 0) deps.log(`pruned ${pruned} agent budget rows`);
  } catch {
    deps.log("agent budget prune failed");
  }
}
