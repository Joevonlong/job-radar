import { readBreakdownSettings } from "@/lib/breakdown/settings";
import { readCareerGate } from "@/lib/config/career-gate";
import type { AgentAction } from "@/lib/config/schemas/mcp";
import type { McpContext } from "@/lib/mcp/context";
import { readResearchSettings } from "@/lib/research/settings";
import { readSalarySettings } from "@/lib/salary/settings";

export async function actionAvailable(ctx: Pick<McpContext, "writer" | "actions">, action: AgentAction): Promise<boolean> {
  if (!ctx.actions) return false;
  switch (action) {
    case "breakdown_job": {
      const settings = readBreakdownSettings();
      return settings.state === "ok" && settings.config.enabled;
    }
    case "research_salary": {
      const settings = readSalarySettings();
      return settings.state === "ok" && settings.config.lookup.enabled;
    }
    case "research_company": {
      const settings = readResearchSettings();
      return settings.state === "ok" && settings.config.enabled;
    }
    case "draft_answer": return ctx.writer?.inputs().writer?.enabled === true;
    case "tailor_resume": return (await readCareerGate()).enabled;
    default: return true;
  }
}

export const actionAvailability = (action: AgentAction) => ({
  available: (ctx: Pick<McpContext, "writer" | "actions">) => actionAvailable(ctx, action),
  category: "disabled",
  message: "errors.actionDisabled" as const,
});
