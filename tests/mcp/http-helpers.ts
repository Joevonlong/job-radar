import { vi } from "vitest";

import type { TokenGrant } from "@/lib/agent-access/tokens";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { realDeps, type McpHttpDependencies } from "@/lib/mcp/http";

export const SECRET = "jrat_uniqueSentinelTokenNeverPrinted1234567890ab";
export const grant: TokenGrant = { kind: "token", tokenId: 42, permissions: ["jobs:read"] };
export const NOW = new Date("2026-11-11T12:00:00Z");
export const settings = (http: Record<string, unknown> = {}) => mcpSchema.parse({ enabled: true, http: { enabled: true, ...http } });

export function fakeDeps() {
  const read = {} as Db;
  const write = {} as Db;
  const audit = { record: vi.fn(async () => {}), inTransaction: vi.fn(async () => 1), close: vi.fn(async () => {}) };
  return {
    ...realDeps(),
    readSettings: vi.fn(() => settings()), password: vi.fn<McpHttpDependencies["password"]>(() => ({ kind: "plain", plain: "test-password" })),
    readDb: vi.fn(() => read), writeDb: vi.fn(() => write), audit: vi.fn(() => audit),
    verify: vi.fn<McpHttpDependencies["verify"]>(async () => ({ ok: true, grant })), markUsed: vi.fn(async () => {}),
    readGrant: vi.fn(() => vi.fn(async () => grant)), writerEnabled: vi.fn(() => false),
    log: vi.fn(), now: () => NOW,
  } satisfies McpHttpDependencies;
}

export function rpcRequest(options: { token?: string | null; headers?: HeadersInit; body?: BodyInit; url?: string; signal?: AbortSignal } = {}) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (options.token !== null) headers.set("authorization", `Bearer ${options.token ?? SECRET}`);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request(options.url ?? "http://mcp.example.test/api/mcp", {
    method: "POST", headers, signal: options.signal,
    body: options.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    ...options.body instanceof ReadableStream ? { duplex: "half" } : {},
  });
}

export async function snapshot(response: Response) {
  expectHygiene(response);
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

export function expectHygiene(response: Response) {
  if (response.headers.get("cache-control") !== "no-store" || response.headers.get("x-content-type-options") !== "nosniff") throw new Error("missing security headers");
  if ([...response.headers.keys()].some((key) => key.startsWith("access-control-"))) throw new Error("unexpected CORS header");
}
