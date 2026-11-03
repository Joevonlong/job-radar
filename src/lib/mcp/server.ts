/**
 * The MCP server (`pnpm mcp:serve`, docs/mcp.md): three tools over the existing job and application queries, and the application
 * writer's two tools, which are off until mcp.yaml switches them on. Only `save_application_answer` writes, and all it can do is
 * add an answer version. `buildServer` registers only the tools offered; the stdio entry point is `scripts/mcp-serve.ts`.
 */
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import { loadConfig } from "@/lib/config";
import type { McpConfig, McpToolName } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { cityMembers } from "@/lib/jobs/city-groups";
import { loadCityGroups } from "@/lib/jobs/cities";
import { buildSearchPlanLenient } from "@/lib/jobs/search";
import { loadBaseCurrency } from "@/lib/signals/floor";
import { readWriterInputs } from "@/lib/writer/settings";

import { formatCallLine, stderrLine, type LogLine } from "./call-log";
import { runLogged, type McpContext } from "./context";
import { getApplicationContextOutput, getJobOutput, listApplicationsOutput, saveApplicationAnswerOutput, searchJobsOutput } from "./dto";
import { toolResult } from "./guard";
import { offeredTools } from "./settings";
import { mcpTranslator, type McpTranslator } from "./text";
import { getApplicationContext, getApplicationContextInput } from "./tools/application-context";
import { getJob, getJobInput } from "./tools/get-job";
import { listApplications, listApplicationsInput } from "./tools/list-applications";
import { saveApplicationAnswer, saveApplicationAnswerInput } from "./tools/save-application-answer";
import { searchJobs, searchJobsInput } from "./tools/search-jobs";

export const MCP_SERVER_NAME = "job-radar";

/** These tools only read, and read only this installation's own database. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Adds a row and changes or removes nothing; calling it twice adds two. */
const ADDS_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** The context with the real loaders (config files, the city groups of the database). */
export function defaultContext(db: Db, settings: McpConfig, options: { text?: McpTranslator; log?: LogLine; writeDb?: Db | null } = {}): McpContext {
  return {
    db,
    settings,
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

/** An MCP server with the tools mcp.yaml switches on. */
export function buildServer(ctx: McpContext, options: { version?: string } = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: options.version ?? "0.0.0" }, { capabilities: { tools: {} } });
  const t = ctx.text;
  const on = new Set<McpToolName>(offeredTools(ctx.settings, ctx.writer?.inputs().writer?.enabled === true));

  if (on.has("search_jobs")) {
    server.registerTool(
      "search_jobs",
      {
        title: t("tools.search_jobs.title"),
        description: t("tools.search_jobs.description"),
        inputSchema: observeInvalidInput(searchJobsInput(ctx), "search_jobs", ctx.log),
        outputSchema: searchJobsOutput,
        annotations: READ_ONLY,
      },
      async (args) =>
        runLogged(ctx, "search_jobs", async () => {
          const output = await searchJobs(ctx, args);
          return { result: toolResult(output), count: output.returned };
        }),
    );
  }

  if (on.has("get_job")) {
    server.registerTool(
      "get_job",
      {
        title: t("tools.get_job.title"),
        description: t("tools.get_job.description"),
        inputSchema: observeInvalidInput(getJobInput(ctx), "get_job", ctx.log),
        outputSchema: getJobOutput,
        annotations: READ_ONLY,
      },
      async (args) =>
        runLogged(ctx, "get_job", async () => {
          const output = await getJob(ctx, args);
          return { result: toolResult(output), count: 1 };
        }),
    );
  }

  if (on.has("list_applications")) {
    server.registerTool(
      "list_applications",
      {
        title: t("tools.list_applications.title"),
        description: t("tools.list_applications.description"),
        inputSchema: observeInvalidInput(listApplicationsInput(ctx), "list_applications", ctx.log),
        outputSchema: listApplicationsOutput,
        annotations: READ_ONLY,
      },
      async (args) =>
        runLogged(ctx, "list_applications", async () => {
          const output = await listApplications(ctx, args);
          return { result: toolResult(output), count: output.returned };
        }),
    );
  }

  if (on.has("get_application_context")) {
    server.registerTool(
      "get_application_context",
      {
        title: t("tools.get_application_context.title"),
        description: t("tools.get_application_context.description"),
        inputSchema: observeInvalidInput(getApplicationContextInput(ctx), "get_application_context", ctx.log),
        outputSchema: getApplicationContextOutput,
        annotations: READ_ONLY,
      },
      async (args) =>
        runLogged(ctx, "get_application_context", async () => {
          const output = await getApplicationContext(ctx, args);
          return { result: toolResult(output), count: output.questions.length };
        }),
    );
  }

  if (on.has("save_application_answer")) {
    server.registerTool(
      "save_application_answer",
      {
        title: t("tools.save_application_answer.title"),
        description: t("tools.save_application_answer.description"),
        inputSchema: observeInvalidInput(saveApplicationAnswerInput(ctx), "save_application_answer", ctx.log),
        outputSchema: saveApplicationAnswerOutput,
        annotations: ADDS_ONLY,
      },
      async (args) =>
        runLogged(ctx, "save_application_answer", async () => {
          const output = await saveApplicationAnswer(ctx, args);
          return { result: toolResult(output), count: 1 };
        }),
    );
  }

  return server;
}
