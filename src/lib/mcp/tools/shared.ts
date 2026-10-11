import type { TrapsConfig } from "@/lib/config/schemas/traps";

import type { McpContext } from "../context";

/** traps.yaml, or null when it cannot be read (short fields then only lose their invisible characters). */
export function readTraps(ctx: Pick<McpContext, "traps">): TrapsConfig | null {
  try {
    return ctx.traps();
  } catch {
    return null;
  }
}

/** How many items one call returns: what the caller asked for, never more than mcp.yaml `limits.max_results`. */
export function resultLimit(ctx: Pick<McpContext, "settings">, asked: number | undefined): number {
  const cap = ctx.settings.limits.max_results;
  return Math.min(asked ?? cap, cap);
}

export function truncationNotice(ctx: Pick<McpContext, "text">, returned: number, total: number, limit: number): string {
  return ctx.text("notice.truncated", { returned, total, limit });
}
