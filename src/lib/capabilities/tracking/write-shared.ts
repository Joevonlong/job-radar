import { AgentWriteError, type AgentWriteAccess } from "@/lib/agent-access/write";
import type { McpContext } from "@/lib/mcp/context";
import { ToolFailure } from "@/lib/mcp/context";
import type { AutoResearchOutcome } from "@/lib/research/auto";

export const trackingWriteAvailability = {
  available: (ctx: Pick<McpContext, "tracking">) => ctx.tracking?.writeDb != null,
  category: "disabled",
  message: "errors.trackingWriteDisabled",
} as const;

export function trackingWriteAccess(ctx: McpContext): AgentWriteAccess {
  if (!ctx.tracking?.writeDb) throw new ToolFailure("disabled", ctx.text("errors.trackingWriteDisabled"));
  if (!ctx.audit || !ctx.auditCall) throw new ToolFailure("audit_unavailable", ctx.text("errors.writeAuditUnavailable"));
  return { caller: ctx.caller?.tokenId ?? "stdio", permissions: ctx.permissions ?? new Set(), audit: ctx.audit, entry: ctx.auditCall.success };
}

export function writeFailure(ctx: McpContext, error: unknown): never {
  if (error instanceof AgentWriteError) throw new ToolFailure(error.code, ctx.text(`errors.undo.${error.code}`));
  throw error;
}

export function researchNotices(ctx: McpContext, research: AutoResearchOutcome | null): string[] {
  return research === "budget_skipped" ? [ctx.text("notice.researchBudgetSkipped")] : [];
}
