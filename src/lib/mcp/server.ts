/**
 * The MCP server (`pnpm mcp:serve`, docs/mcp.md): tools generated from the capability registry, each authorized against the current
 * mcp.yaml on every call. Answer writes add versions; action triggers use the shared control queue with daily budgets. Every capability is
 * registered with the SDK, but `tools/list` is answered by this file instead of the SDK, so the list follows the current settings
 * and lists only what a call would accept. The stdio entry point is scripts/mcp-serve.ts.
 */
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import { authorize, liveMcpSettings, type AccessDecision } from "@/lib/agent-access/authorize";
import { CAPABILITIES, listedCapabilities } from "@/lib/capabilities/registry";
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
import { auditEntry, runLogged, ToolFailure, type McpContext } from "./context";
import { toolResult } from "./guard";
import { mcpTranslator, type McpTranslator } from "./text";

export const MCP_SERVER_NAME = "job-radar";

/** The context with the real loaders (config files, the city groups of the database); `readSettings` defaults to mcp.yaml read fresh from disk. */
export function defaultContext(db: Db, settings: McpConfig, options: { text?: McpTranslator; log?: LogLine; writeDb?: Db | null; actionDb?: Db; readSettings?: () => McpConfig; audit?: McpContext["audit"]; caller?: McpContext["caller"] } = {}): McpContext {
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
    actions: options.actionDb ? { db: options.actionDb } : undefined,
    audit: options.audit,
    caller: options.caller,
  };
}

/**
 * The input schema as the SDK sees it, plus one call log line when the SDK rejects the arguments (the handler then never runs, so
 * the line would be missing). A live schema keeps configuration-dependent bounds consistent with tools/list.
 */
export function observeInvalidInput<S extends StandardSchemaWithJSON>(schema: S, tool: string, log: LogLine, ctx?: Pick<McpContext, "audit" | "caller">, currentSchema?: () => S): S {
  const std = schema["~standard"];
  const validate: typeof std.validate = (value, options) => {
    const started = performance.now();
    const result = (currentSchema?.()["~standard"] ?? std).validate(value, options);
    const report = (outcome: Awaited<typeof result>) => {
      if (outcome.issues && outcome.issues.length > 0) {
        log(formatCallLine({ tool, ok: false, count: 0, ms: performance.now() - started, category: "invalid_input" }));
        void ctx?.audit?.record(auditEntry(ctx, tool, null, { outcome: "invalid_input", error_category: null }, 0, performance.now() - started));
      }
      return outcome;
    };
    return result instanceof Promise ? result.then(report) : report(result);
  };
  return { "~standard": { ...std, validate } } as unknown as S;
}

/** The denial message uses only the safe problem summary or permission. */
function accessFailure(decision: Exclude<AccessDecision, { allowed: true }>, text: McpTranslator): ToolFailure {
  switch (decision.reason) {
    case "unreadable": return new ToolFailure("settings_unreadable", text("errors.settingsUnreadable", { problem: decision.problem }));
    case "disabled": return new ToolFailure("not_permitted", text("errors.serverOff"));
    case "missing_permission": return new ToolFailure("not_permitted", text("errors.notPermitted", { permission: decision.permission }));
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
        inputSchema: observeInvalidInput(cap.input(ctx), cap.id, ctx.log, ctx, () => cap.input(ctx)),
        outputSchema: cap.output,
        annotations: cap.annotations,
      },
      async (args) =>
        runLogged(ctx, cap.id, async (callCtx) => {
          const decision = authorize(cap, ctx.readSettings);
          if (!decision.allowed) throw accessFailure(decision, t);
          if (cap.availability && !await cap.availability.available(ctx)) throw new ToolFailure(cap.availability.category, t(cap.availability.message));
          const output = await cap.handler({ ...callCtx, settings: decision.settings, permissions: decision.permissions }, args);
          const parsed = (cap.outputFor?.(decision.permissions) ?? cap.output).parse(output);
          return { result: toolResult(parsed), count: cap.count(parsed) };
        }, cap.target?.(args) ?? null),
    );
  }

  server.server.removeRequestHandler("tools/list");
  server.server.setRequestHandler("tools/list", async () => ({
    tools: (await listedCapabilities(capabilities, ctx)).map(({ capability: cap, permissions }) => {
      const inputSchema = cap.input(ctx)["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      const outputSchema = (cap.outputFor?.(permissions) ?? cap.output)["~standard"].jsonSchema.output({ target: "draft-2020-12" });
      return {
        name: cap.id,
        title: t(cap.text.title),
        description: t(cap.text.description),
        inputSchema: { type: "object" as const, ...inputSchema },
        annotations: cap.annotations,
        outputSchema: outputSchema.type === undefined ? { type: "object", ...outputSchema } : outputSchema,
      };
    }),
  }));

  return server;
}
