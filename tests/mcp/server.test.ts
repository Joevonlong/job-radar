// @vitest-environment node
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { mcpSchema, type McpConfig } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { formatCallLine } from "@/lib/mcp/call-log";
import { errorCategory, runLogged, ToolFailure, type McpContext } from "@/lib/mcp/context";
import { buildServer } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

import { trapSettings } from "../traps/helpers";

/** A database that fails the test when touched: invalid arguments must never reach a query. */
const untouchable = new Proxy({} as Db, {
  get() {
    throw new Error("the database was touched");
  },
});

function context(settings: Partial<McpConfig> = {}, lines: string[] = []): McpContext {
  return {
    db: untouchable,
    settings: mcpSchema.parse({ enabled: true, ...settings }),
    now: () => new Date("2026-10-11T10:00:00Z"),
    timezone: () => "Europe/Berlin",
    traps: () => trapSettings(),
    reminderDays: () => ({ interested: 7, applied: 14 }),
    baseCurrency: () => "EUR",
    cityMembers: async (_db, city) => [city],
    locationTerms: (query) => [query],
    text: mcpTranslator("en"),
    log: (line) => lines.push(line),
  };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function connect(ctx: McpContext): Promise<Client> {
  const server = buildServer(ctx, { version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  close = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

const textOf = (result: { content?: unknown }): string => ((result.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? "").join("\n");

describe("tools/list", () => {
  it("offers the three read-only tools with titles, descriptions and schemas", async () => {
    const client = await connect(context());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_jobs", "get_job", "list_applications"]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.outputSchema).toBeDefined();
    }
    const search = tools.find((t) => t.name === "search_jobs");
    expect(Object.keys((search?.inputSchema as { properties: object }).properties)).toEqual(["query", "city", "workplace", "min_rank", "min_annual_salary", "since", "until", "application_status", "sort", "limit"]);
    expect((search?.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
  it("leaves out a tool mcp.yaml switches off", async () => {
    const client = await connect(context({ tools: { search_jobs: true, get_job: false, list_applications: true } }));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["search_jobs", "list_applications"]);
  });
});

describe("invalid arguments", () => {
  it.each([
    ["search_jobs", { limit: 101 }, "limit"],
    ["search_jobs", { limit: 0 }, "limit"],
    ["search_jobs", { min_rank: 101 }, "min_rank"],
    ["search_jobs", { min_annual_salary: -1 }, "min_annual_salary"],
    ["search_jobs", { since: "2026-02-30" }, "since"],
    ["search_jobs", { since: "11.10.2026" }, "since"],
    ["search_jobs", { query: "x".repeat(201) }, "query"],
    ["search_jobs", { city: "y".repeat(121) }, "city"],
    ["search_jobs", { workplace: ["moon"] }, "workplace"],
    ["search_jobs", { sort: "salary" }, "sort"],
    ["search_jobs", { delete: true }, "delete"],
    ["get_job", {}, "job_id"],
    ["get_job", { job_id: -3 }, "job_id"],
    ["get_job", { job_id: "7; drop table jobs" }, "job_id"],
    ["list_applications", { status: ["dreaming"] }, "status"],
    ["list_applications", { stale_only: "yes" }, "stale_only"],
  ])("%s %j is an error result naming %s, and is logged without the arguments", async (tool, args, field) => {
    const lines: string[] = [];
    const client = await connect(context({}, lines));
    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(field);
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[mcp\\] ${tool} fail invalid_input items=0 ms=\\d+$`))]);
  });
  it("a switched-off tool cannot be called", async () => {
    const client = await connect(context({ tools: { search_jobs: true, get_job: false, list_applications: true } }));
    const result = await client.callTool({ name: "get_job", arguments: { job_id: 1 } }).catch((error: unknown) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
    expect(result.isError).toBe(true);
  });
});

describe("the call log", () => {
  const ctx = context();
  it("one line: tool, ok, item count, time; never the arguments", async () => {
    const lines: string[] = [];
    const result = await runLogged({ ...ctx, log: (l) => lines.push(l) }, "search_jobs", async () => ({ result: "fine", count: 3 }));
    expect(result).toBe("fine");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[mcp\] search_jobs ok items=3 ms=\d+$/);
  });
  it("a failure is reported by category: a database error never shows its message", async () => {
    const lines: string[] = [];
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433 password "hunter2"'), { code: "ECONNREFUSED" });
    const result = await runLogged({ ...ctx, log: (l) => lines.push(l) }, "get_job", async () => {
      throw error;
    });
    expect(result).toEqual({ content: [{ type: "text", text: expect.stringContaining("(database)") }], isError: true });
    expect(JSON.stringify(result)).not.toContain("5433");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(lines).toEqual([expect.stringMatching(/^\[mcp\] get_job fail database items=0 ms=\d+$/)]);
  });
  it("a database error wrapped by the query builder (code on the cause) is still a database error", async () => {
    const sqlState = Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" });
    expect(errorCategory(new Error("Failed query: insert into jobs ...", { cause: sqlState }))).toBe("database");
    expect(errorCategory(new Error("Failed query", { cause: new Error("wrapped twice", { cause: refused }) }))).toBe("database");
    expect(errorCategory(refused)).toBe("database");
    expect(errorCategory(new TypeError("x is undefined"))).toBe("internal");
    expect(errorCategory("a string was thrown")).toBe("internal");
    expect(errorCategory(null)).toBe("internal");
    const lines: string[] = [];
    const result = await runLogged({ ...ctx, log: (l) => lines.push(l) }, "search_jobs", async () => {
      throw new Error("Failed query: select ... params: secret", { cause: sqlState });
    });
    expect(JSON.stringify(result)).toContain("(database)");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(lines[0]).toContain("fail database");
  });
  it("a ToolFailure keeps its own message", async () => {
    const lines: string[] = [];
    const result = await runLogged({ ...ctx, log: (l) => lines.push(l) }, "get_job", async () => {
      throw new ToolFailure("not_found", "No job with id 9.");
    });
    expect(result).toEqual({ content: [{ type: "text", text: "No job with id 9." }], isError: true });
    expect(lines[0]).toContain("fail not_found");
  });
  it("formats a line", () => {
    expect(formatCallLine({ tool: "list_applications", ok: true, count: 0, ms: 12.6 })).toBe("[mcp] list_applications ok items=0 ms=13");
  });
});
