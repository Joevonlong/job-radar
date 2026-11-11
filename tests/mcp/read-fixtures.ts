import type { Permission } from "@/lib/agent-access/permissions";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import type { McpContext } from "@/lib/mcp/context";
import { mcpTranslator } from "@/lib/mcp/text";
import { trapSettings } from "../traps/helpers";
import { BLOCK_NOW } from "./job-block-fixtures";

export function readContext(permissions: readonly Permission[] = ["jobs:read", "tracking:read"], cap = 20): McpContext {
  const settings = mcpSchema.parse({ enabled: true, limits: { max_results: cap } });
  return { db: {} as Db, settings, readSettings: () => settings, permissions: new Set(permissions), now: () => BLOCK_NOW, timezone: () => "UTC", traps: () => trapSettings(), reminderDays: () => ({ interested: 7, applied: 14 }), baseCurrency: () => "EUR", cityMembers: async () => [], searchPlan: () => { throw new Error("unused"); }, text: mcpTranslator("en"), log: () => {} };
}
