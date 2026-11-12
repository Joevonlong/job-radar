// @vitest-environment node
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

const db = new Proxy({} as Db, { get: () => { throw new Error("must not touch the database"); } });
const inputs = {
  set_application_status: { job_id: 1, status: "interested" }, mark_applied: { job_id: 1 },
  set_next_action: { job_id: 1, next_action: "Next", next_action_date: null }, set_interview_rounds: { job_id: 1, rounds: 1 }, undo_change: { audit_id: 1 },
};

it("rechecks revocation for all writes and hides them without a granted write connection", async () => {
  let settings = mcpSchema.parse({ enabled: true, permissions: ["tracking:write"], stdio: { permissions: ["tracking:write"] } });
  const ctx = defaultContext(db, settings, { trackingWriteDb: db, readSettings: () => settings, text: mcpTranslator("en"), log: () => undefined });
  const server = buildServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "tracking-test", version: "1" });
  await client.connect(ct);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(Object.keys(inputs));
    settings = mcpSchema.parse({ enabled: true, permissions: [], stdio: { permissions: ["tracking:write"] } });
    expect((await client.listTools()).tools).toEqual([]);
    for (const [name, args] of Object.entries(inputs)) expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true });
    settings = mcpSchema.parse({ enabled: true, permissions: ["tracking:write"], stdio: { permissions: ["tracking:write"] } });
    ctx.tracking = { writeDb: null };
    expect((await client.listTools()).tools).toEqual([]);
    for (const [name, args] of Object.entries(inputs)) expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true });
  } finally { await client.close(); await server.close(); }
});
