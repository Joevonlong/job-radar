/**
 * Registry-generated MCP tools, with a live filtered list and authorization against the current mcp.yaml on every call.
 * The stdio entry point is scripts/mcp-serve.ts.
 */
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import { authorize, liveMcpSettings, type AccessDecision } from "@/lib/agent-access/authorize";
import { CAPABILITIES, visibleCapabilities } from "@/lib/capabilities/registry";
import type { Capability } from "@/lib/capabilities/types";
import { loadConfig } from "@/lib/config";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { cityMembers } from "@/lib/jobs/city-groups";
import { loadCityGroups } from "@/lib/jobs/cities";
import { buildSearchPlanLenient } from "@/lib/jobs/search";
import { loadBaseCurrency } from "@/lib/signals/floor";
import { readWriterInputs } from "@/lib/writer/settings";

import { formatCallLine, stderrLine, type LogLine } from "./call-log";
import { runLogged, ToolFailure, type McpContext } from "./context";
import { toolResult } from "./guard";
import { mcpTranslator, type McpTranslator } from "./text";

export const MCP_SERVER_NAME = "job-radar";

/** The context with the real loaders (config files, the city groups of the database); `readSettings` defaults to mcp.yaml read fresh from disk. */
export function defaultContext(db: Db, settings: McpConfig, options: { text?: McpTranslator; log?: LogLine; writeDb?: Db | null; readSettings?: () => McpConfig } = {}): McpContext {
  return {
    db,
    settings,
    readSettings: options.readSettings ?? liveMcpSettings,
    now: () => new Date(),
    timezone: () => loadConfig("schedule").timezone,
    traps: () => loadConfig("traps"),
    reminderDays: () => {
      const reminders = loadConfig("notify").reminders;
      return { interested: reminders.interested_days, applied: reminders.applied_days };
    },
    baseCurrency: loadBaseCurrency,
    cityMembers: async (database, city) => cityMembers(await loadCityGroups(database), city),
    searchPlan: buildSearchPlanLenient,
    text: options.text ?? mcpTranslator(),
    log: options.log ?? stderrLine,
    writer: { inputs: readWriterInputs, writeDb: options.writeDb ?? null },
  };
}

/**
 * The input schema as the SDK sees it, plus one call log line when the SDK rejects the arguments (the handler then never runs, so
 * the line would be missing). The JSON Schema the client is shown is the original one.
 */
export function observeInvalidInput<S extends StandardSchemaWithJSON>(schema: S, tool: string, log: LogLine): S {
  const std = schema["~standard"];
  const validate: typeof std.validate = (value, options) => {
    const started = performance.now();
    const result = std.validate(value, options);
    const report = (outcome: Awaited<typeof result>) => {
      if (outcome.issues && outcome.issues.length > 0) log(formatCallLine({ tool, ok: false, count: 0, ms: performance.now() - started, category: "invalid_input" }));
      return outcome;
    };
    return result instanceof Promise ? result.then(report) : report(result);
  };
  return { "~standard": { ...std, validate } } as unknown as S;
}

/** The denial message uses only the safe problem summary, permission or capability name. */
function accessFailure(decision: Exclude<AccessDecision, { allowed: true }>, capability: Capability, text: McpTranslator): ToolFailure {
  switch (decision.reason) {
    case "unreadable": return new ToolFailure("settings_unreadable", text("errors.settingsUnreadable", { problem: decision.problem }));
    case "disabled": return new ToolFailure("not_permitted", text("errors.serverOff"));
    case "missing_permission": return new ToolFailure("not_permitted", text("errors.notPermitted", { permission: decision.permission }));
    case "switched_off": return new ToolFailure("not_permitted", text("errors.toolSwitchedOff", { tool: capability.id }));
  }
}

/** All capabilities can receive calls; only those currently authorized and available are listed. */
export function buildServer(ctx: McpContext, options: { version?: string; capabilities?: readonly Capability[] } = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: options.version ?? "0.0.0" }, { capabilities: { tools: {} } });
  const capabilities = options.capabilities ?? CAPABILITIES;
  const t = ctx.text;

  for (const cap of capabilities) {
    server.registerTool(
      cap.id,
      {
        title: t(cap.text.title),
        description: t(cap.text.description),
        inputSchema: observeInvalidInput(cap.input(ctx), cap.id, ctx.log),
        outputSchema: cap.output,
        annotations: cap.annotations,
      },
      async (args) =>
        runLogged(ctx, cap.id, async () => {
          const decision = authorize(cap, ctx.readSettings);
          if (!decision.allowed) throw accessFailure(decision, cap, t);
          const output = await cap.handler({ ...ctx, settings: decision.settings }, args);
          return { result: toolResult(output), count: cap.count(output) };
        }),
    );
  }

  server.server.removeRequestHandler("tools/list");
  server.server.setRequestHandler("tools/list", () => ({
    tools: visibleCapabilities(capabilities, ctx).map((cap) => {
      const outputSchema = cap.output["~standard"].jsonSchema.output({ target: "draft-2020-12" });
      return {
        name: cap.id,
        title: t(cap.text.title),
        description: t(cap.text.description),
        inputSchema: { type: "object" as const, ...server.toolInputSchemaJson(cap.id) },
        annotations: cap.annotations,
        outputSchema: outputSchema.type === undefined ? { type: "object", ...outputSchema } : outputSchema,
      };
    }),
  }));

  return server;
}
