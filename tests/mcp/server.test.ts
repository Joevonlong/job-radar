// @vitest-environment node
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CAPABILITIES } from "@/lib/capabilities/registry";
import { defineCapability, READ_ONLY, type Capability } from "@/lib/capabilities/types";

import { writerSchema } from "@/lib/config";
import { mcpSchema, type McpConfig } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { formatCallLine } from "@/lib/mcp/call-log";
import { errorCategory, runLogged, ToolFailure, type McpContext } from "@/lib/mcp/context";
import { buildServer } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

import { searchPlan } from "../fixtures/job-search";
import { trapSettings } from "../traps/helpers";

/** A database that fails the test when touched: invalid arguments must never reach a query. */
const untouchable = new Proxy({} as Db, {
  get() {
    throw new Error("the database was touched");
  },
});

function context(settings: Partial<McpConfig> = {}, lines: string[] = []): McpContext {
  const parsed = mcpSchema.parse({ enabled: true, ...settings });
  return {
    db: untouchable,
    settings: parsed,
    readSettings: () => parsed,
    now: () => new Date("2026-10-11T10:00:00Z"),
    timezone: () => "Europe/Berlin",
    traps: () => trapSettings(),
    reminderDays: () => ({ interested: 7, applied: 14 }),
    baseCurrency: () => "EUR",
    cityMembers: async (_db, city) => [city],
    searchPlan,
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
    expect(Object.keys((search?.inputSchema as { properties: object }).properties)).toEqual(["query", "search_in", "country", "city", "workplace", "min_rank", "min_annual_salary", "since", "until", "application_status", "sort", "limit"]);
    expect((search?.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
  describe("the writer tools", () => {
    const on = { tools: { search_jobs: true, get_job: true, list_applications: true, get_application_context: true, save_application_answer: true } };
    const withWriter = (enabled: boolean) => ({ ...context(on), writer: { inputs: () => ({ writer: writerSchema.parse({ enabled }), me: null, stories: [], storiesUnreadable: false, breakdownEnabled: true }), writeDb: null } });
    const names = async (ctx: McpContext) => (await (await connect(ctx)).listTools()).tools;

    it("are offered with their switch and the writer on; only the save tool says it writes, and that it destroys nothing", async () => {
      const tools = await names(withWriter(true));
      expect(tools.map((t) => t.name)).toEqual(["search_jobs", "get_job", "list_applications", "get_application_context", "save_application_answer"]);
      expect(tools.find((t) => t.name === "get_application_context")?.annotations).toMatchObject({ readOnlyHint: true });
      expect(tools.find((t) => t.name === "save_application_answer")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      const save = tools.find((t) => t.name === "save_application_answer");
      expect(Object.keys((save?.inputSchema as { properties: object }).properties).sort()).toEqual(["job_id", "question_id", "sentences", "text"]);
      expect((save?.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    });
    it("are not offered while the writer is off, or without their switch", async () => {
      expect((await names(withWriter(false))).map((t) => t.name)).toEqual(["search_jobs", "get_job", "list_applications"]);
      expect((await names({ ...withWriter(true), settings: context().settings, readSettings: context().readSettings })).map((t) => t.name)).toEqual(["search_jobs", "get_job", "list_applications"]);
    });
    it("a save without a writable connection is refused before anything is read", async () => {
      const client = await connect(withWriter(true));
      const result = await client.callTool({ name: "save_application_answer", arguments: { job_id: 1, question_id: 1, text: "An answer." } });
      expect(result.isError).toBe(true);
    });
  });
  it("leaves out a tool mcp.yaml switches off", async () => {
    const client = await connect(context({ tools: { search_jobs: true, get_job: false, list_applications: true, get_application_context: false, save_application_answer: false } }));
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
    ["search_jobs", { search_in: "jd" }, "search_in"],
    ["search_jobs", { country: ["DEU"] }, "country"],
    ["search_jobs", { country: [] }, "country"],
    ["search_jobs", { country: Array.from({ length: 21 }, () => "DE") }, "country"],
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
    const client = await connect(context({ tools: { search_jobs: true, get_job: false, list_applications: true, get_application_context: false, save_application_answer: false } }));
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

describe("tools come from the registry", () => {
  const fake = defineCapability({
    id: "registry_probe",
    kind: "read",
    permission: "jobs:read",
    input: () => z.strictObject({ value: z.string().trim().transform((value) => value.toUpperCase()) }),
    output: z.strictObject({ notices: z.array(z.string()), value: z.string(), limit: z.number() }),
    handler: async (ctx, args) => ({ notices: [], value: args.value, limit: ctx.settings.limits.max_results }),
    count: () => 1,
    annotations: READ_ONLY,
    text: { title: "tools.search_jobs.title", description: "tools.search_jobs.description" },
  });

  async function connectCapabilities(ctx: McpContext, capabilities: readonly Capability[]): Promise<Client> {
    const server = buildServer(ctx, { capabilities });
    return connectServer(server);
  }

  async function connectServer(server: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "registry-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const previousClose = close;
    close = async () => {
      await client.close();
      await server.close();
      await previousClose?.();
    };
    return client;
  }

  it("offers and calls an injected capability using its schema and the settings just read", async () => {
    const ctx = context();
    ctx.readSettings = () => mcpSchema.parse({ enabled: true, limits: { max_results: 4 } });
    const client = await connectCapabilities(ctx, [...CAPABILITIES, fake]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["search_jobs", "get_job", "list_applications", "registry_probe"]);
    const result = await client.callTool({ name: fake.id, arguments: { value: " hello " } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ notices: [], value: "HELLO", limit: 4 });
  });

  it("hides the injected capability and refuses a direct call without its permission", async () => {
    const lines: string[] = [];
    const client = await connectCapabilities(context({ tools: { search_jobs: false, get_job: false, list_applications: true } }, lines), [...CAPABILITIES, fake]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(fake.id);
    const result = await client.callTool({ name: fake.id, arguments: { value: "hello" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("jobs:read");
    expect(lines).toEqual([expect.stringMatching(/^\[mcp\] registry_probe fail not_permitted items=0 ms=\d+$/)]);
  });

  it("lists byte-identical tool definitions to the SDK for all five tools", async () => {
    const ctx = context({ tools: { search_jobs: true, get_job: true, list_applications: true, get_application_context: true, save_application_answer: true } });
    ctx.writer = { inputs: () => ({ writer: writerSchema.parse({ enabled: true }), me: null, stories: [], storiesUnreadable: false, breakdownEnabled: true }), writeDb: null };
    const reference = new McpServer({ name: "reference", version: "1" }, { capabilities: { tools: {} } });
    for (const cap of CAPABILITIES) {
      reference.registerTool(cap.id, { title: ctx.text(cap.text.title), description: ctx.text(cap.text.description), inputSchema: cap.input(ctx), outputSchema: cap.output, annotations: cap.annotations }, async () => ({ content: [], isError: true }));
    }
    const sdk = await connectServer(reference);
    const client = await connectCapabilities(ctx, CAPABILITIES);
    expect(JSON.stringify(await client.listTools())).toBe(JSON.stringify(await sdk.listTools()));
  });
});

describe("permissions decide visibility", () => {
  const cases = [
    { name: "search_jobs", tools: { search_jobs: false, get_job: false }, permission: "jobs:read", args: {} },
    { name: "get_job", tools: { search_jobs: false, get_job: false }, permission: "jobs:read", args: { job_id: 1 } },
    { name: "list_applications", tools: { list_applications: false }, permission: "tracking:read", args: {} },
    { name: "get_application_context", tools: { get_application_context: false }, permission: "writer:read", args: { job_id: 1 } },
    { name: "save_application_answer", tools: { save_application_answer: false }, permission: "writer:write", args: { job_id: 1, question_id: 1, text: "An answer." } },
  ];

  it.each(cases)("hides and refuses $name without $permission before touching the database", async ({ name, tools, permission, args }) => {
    const lines: string[] = [];
    const ctx = context({ tools: mcpSchema.parse({ tools }).tools }, lines);
    ctx.writer = { inputs: () => ({ writer: writerSchema.parse({ enabled: true }), me: null, stories: [], storiesUnreadable: false, breakdownEnabled: true }), writeDb: untouchable };
    const client = await connect(ctx);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(name);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(permission);
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[mcp\\] ${name} fail not_permitted items=0 ms=\\d+$`))]);
  });

  it("keeps a shared permission while refusing a tool whose own switch is off", async () => {
    const lines: string[] = [];
    const ctx = context({ tools: { search_jobs: true, get_job: false, list_applications: true } }, lines);
    const client = await connect(ctx);
    const result = await client.callTool({ name: "get_job", arguments: { job_id: 1 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(ctx.text("errors.toolSwitchedOff", { tool: "get_job" }));
    expect(lines).toEqual([expect.stringMatching(/^\[mcp\] get_job fail not_permitted items=0 ms=\d+$/)]);
  });
});

describe("authorization on every call", () => {
  it("applies changed grants, server disablement and unreadable settings to the same connection", async () => {
    const lines: string[] = [];
    const ctx = context({}, lines);
    let current = ctx.settings;
    let unreadable = false;
    ctx.readSettings = () => {
      if (unreadable) throw new Error("cannot read /private/config/mcp.yaml");
      return current;
    };
    const client = await connect(ctx);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("list_applications");

    current = mcpSchema.parse({ enabled: true, tools: { list_applications: false } });
    const tracking = await client.callTool({ name: "list_applications", arguments: {} });
    expect(tracking.isError).toBe(true);
    expect(textOf(tracking)).toBe(ctx.text("errors.notPermitted", { permission: "tracking:read" }));
    expect(lines).toEqual([expect.stringMatching(/^\[mcp\] list_applications fail not_permitted items=0 ms=\d+$/)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["search_jobs", "get_job"]);

    await client.callTool({ name: "search_jobs", arguments: {} });
    expect(lines.at(-1)).toMatch(/^\[mcp\] search_jobs fail internal items=0 ms=\d+$/);

    current = mcpSchema.parse({ enabled: false });
    const disabled = await client.callTool({ name: "search_jobs", arguments: {} });
    expect(disabled.isError).toBe(true);
    expect(textOf(disabled)).toBe(ctx.text("errors.serverOff"));
    expect(lines.at(-1)).toContain("fail not_permitted");
    expect((await client.listTools()).tools).toEqual([]);

    unreadable = true;
    const broken = await client.callTool({ name: "search_jobs", arguments: {} });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toBe(ctx.text("errors.settingsUnreadable", { problem: "unreadable" }));
    expect(textOf(broken)).not.toContain("/private");
    expect(lines.at(-1)).toContain("fail settings_unreadable");
    expect(lines).toHaveLength(4);
    expect((await client.listTools()).tools).toEqual([]);
  });
});
