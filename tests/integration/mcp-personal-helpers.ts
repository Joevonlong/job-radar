import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { sql } from "drizzle-orm";
import type { Permission } from "@/lib/agent-access/permissions";
import type { AuditEntry } from "@/lib/agent-access/audit";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

export async function personalClient(db: Db, permissions: Permission[], options: {
  transport?: "stdio" | "http";
  maxResults?: number;
} = {}) {
  const transport = options.transport ?? "stdio";
  const settings = mcpSchema.parse({ enabled: true, permissions, stdio: { permissions }, limits: { max_results: options.maxResults ?? 100 } });
  const audit: AuditEntry[] = [];
  const grant = { kind: "token" as const, tokenId: 1, permissions };
  const ctx = defaultContext(db, settings, {
    text: mcpTranslator("en"),
    readSettings: () => settings,
    log: () => {},
    caller: transport === "stdio" ? { caller: "stdio", tokenId: null, transport } : { caller: "token", tokenId: 1, transport },
    ...(transport === "http" ? { grant, readGrant: async () => grant } : {}),
    audit: {
      record: async (entry) => { audit.push(entry); },
      inTransaction: async () => { throw new Error("unexpected write"); },
      close: async () => {},
    },
  });
  ctx.now = () => new Date("2026-01-15T12:00:00Z");
  ctx.timezone = () => "UTC";
  const server = buildServer(ctx);
  const client = new Client({ name: "personal-read-test", version: "1" });
  if (transport === "http") {
    const http = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => "test-session", enableJsonResponse: true });
    await server.connect(http);
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => http.handleRequest(new Request(input, init)),
    }));
  } else {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  }
  return { client, ctx, audit, close: async () => { await client.close(); await server.close(); } };
}

export function fileHashes(root: string) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
    const name = path.join(e.parentPath, e.name);
    return [path.relative(root, name), createHash("sha256").update(fs.readFileSync(name)).digest("hex")];
  }).sort(([a], [b]) => a!.localeCompare(b!));
}

export async function databaseHashes(db: Db) {
  const tables = await db.execute<{ name: string }>(sql`select tablename as name from pg_tables where schemaname = 'public' order by tablename`);
  const result: Record<string, unknown> = {};
  for (const { name } of tables) {
    result[name] = await db.execute(sql.raw(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as hash from "${name.replaceAll('"', '""')}" t`));
  }
  return result;
}
