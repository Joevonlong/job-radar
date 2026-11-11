/** Token-authenticated, stateless HTTP serving. Preconditions run before credentials or pools are touched. */
import { createHash } from "node:crypto";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import { authorize, liveMcpSettings } from "@/lib/agent-access/authorize";
import { agentTokenGrantReader, bearerAgentToken, verifyAgentToken } from "@/lib/agent-access/tokens";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { getMcpAuditRecorder, getMcpReadDb, getMcpWriteDb } from "@/lib/db/mcp-pools";
import { markAgentTokenUsed } from "@/lib/db/repos/agent-tokens";
import { LoginThrottle, throttleKey, type ThrottleLimits } from "@/lib/security/login-throttle";
import { readPasswordSetting } from "@/lib/security/password";
import { readWriterEnabled } from "@/lib/writer/settings";

import { version } from "../../../package.json";
import { stderrLine } from "./call-log";
import { errorCategory } from "./context";
import { buildServer, defaultContext } from "./server";

export interface McpHttpDependencies {
  readSettings: typeof liveMcpSettings;
  password: () => ReturnType<typeof readPasswordSetting>;
  readDb: typeof getMcpReadDb;
  writeDb: typeof getMcpWriteDb;
  audit: typeof getMcpAuditRecorder;
  verify: typeof verifyAgentToken;
  markUsed: typeof markAgentTokenUsed;
  readGrant: typeof agentTokenGrantReader;
  writerEnabled: typeof readWriterEnabled;
  createHandler: typeof createMcpHandler;
  log: (line: string) => void;
  now: () => Date;
}

export function realDeps(): McpHttpDependencies {
  return {
    readSettings: liveMcpSettings, password: () => readPasswordSetting(process.env),
    readDb: getMcpReadDb, writeDb: getMcpWriteDb, audit: getMcpAuditRecorder,
    verify: verifyAgentToken, markUsed: markAgentTokenUsed, readGrant: agentTokenGrantReader,
    writerEnabled: readWriterEnabled, createHandler: createMcpHandler, log: stderrLine, now: () => new Date(),
  };
}

interface HttpState { throttle: LoginThrottle; inFlight: number }
const globalForHttp = globalThis as typeof globalThis & { __jobRadarMcpHttp?: HttpState };
const state = (): HttpState => globalForHttp.__jobRadarMcpHttp ??= { throttle: new LoginThrottle(), inFlight: 0 };

export function resetMcpThrottle(now?: () => number): void {
  state().throttle = new LoginThrottle(now);
}

function limitsOf(settings: McpConfig["http"]["throttle"]): ThrottleLimits {
  return {
    maxFailures: settings.max_failures, windowMs: settings.window_minutes * 60_000,
    lockoutMs: settings.lockout_minutes * 60_000, globalMaxFailures: settings.global_max_failures,
    globalDelayMs: settings.global_delay_seconds * 1000,
  };
}

function hygiene(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("access-control-")) headers.delete(name);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function refusal(status: number, error: string, headers?: HeadersInit, extra?: { retry_after: number }): Response {
  return hygiene(Response.json({ error, ...extra }, { status, headers }));
}

export function mcpMethodNotAllowed(): Response {
  return refusal(405, "method_not_allowed", { Allow: "POST" });
}

/** The slot belongs to the response consumer, including the legacy SSE path; no prefetch may release it early. */
function releaseWithBody(response: Response, release: () => void, log: McpHttpDependencies["log"]): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { release(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        release();
        log(`[mcp] http stream error: ${errorCategory(error)}`);
        controller.error(new Error("internal"));
      }
    },
    async cancel() {
      release();
      try { await reader.cancel(); } catch (error) { log(`[mcp] http stream error: ${errorCategory(error)}`); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const contentLength = z.string().regex(/^\d+$/).transform(BigInt);

export async function handleMcpHttpRequest(request: Request, deps: McpHttpDependencies = realDeps()): Promise<Response> {
  let release: (() => void) | undefined;
  try {
    let settings: McpConfig;
    try { settings = deps.readSettings(); } catch { return refusal(404, "not_found"); }
    if (!settings.enabled || !settings.http.enabled) return refusal(404, "not_found");
    const password = deps.password();
    if (password === null || (password.kind === "hash" && password.parsed === null)) return refusal(503, "web_password_required");
    const key = throttleKey(request.headers.get("x-forwarded-for"));
    const current = state();
    const check = current.throttle.check(key);
    if (!check.allowed) return refusal(429, "too_many_attempts", { "Retry-After": String(check.retryAfterSeconds) }, { retry_after: check.retryAfterSeconds });
    if (current.inFlight >= settings.http.pool.max_concurrent) return refusal(503, "busy", { "Retry-After": "1" });
    current.inFlight++;
    let released = false;
    let response: Response | undefined;
    const abort = () => {
      release?.();
      void response?.body?.cancel().catch(() => undefined);
    };
    release = () => {
      if (!released) {
        released = true;
        current.inFlight--;
        request.signal.removeEventListener("abort", abort);
      }
    };
    request.signal.addEventListener("abort", abort, { once: true });
    request.signal.throwIfAborted();
    response = await authenticatedResponse(request, deps, settings, key, current.throttle);
    if (request.signal.aborted) {
      abort();
      request.signal.throwIfAborted();
    }
    response = releaseWithBody(hygiene(response), release, deps.log);
    return response;
  } catch (error) {
    release?.();
    deps.log(`[mcp] http error: ${errorCategory(error)}`);
    return refusal(500, "internal");
  }
}

async function authenticatedResponse(request: Request, deps: McpHttpDependencies, settings: McpConfig, key: string, throttle: LoginThrottle): Promise<Response> {
  const secret = bearerAgentToken(request.headers.get("authorization"));
  let verified: Awaited<ReturnType<typeof verifyAgentToken>> = { ok: false, reason: "malformed" };
  let readDb;
  if (secret !== null) {
    try {
      readDb = deps.readDb(settings);
      verified = await deps.verify(readDb, secret, deps.now());
    } catch (error) {
      deps.log(`[mcp] http verification failed: ${errorCategory(error)}`);
      return refusal(503, "unavailable");
    }
  }
  if (!verified.ok || !readDb) {
    throttle.recordFailure(key, limitsOf(settings.http.throttle));
    deps.log(`[mcp] http request refused (401) source ${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8)}`);
    return refusal(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  throttle.recordSuccess(key);
  request.signal.throwIfAborted();
  const declared = contentLength.safeParse(request.headers.get("content-length"));
  if (declared.success && declared.data > BigInt(settings.http.max_body_bytes)) return refusal(413, "payload_too_large");
  const { grant } = verified;
  try { await deps.markUsed(deps.writeDb(settings), grant.tokenId, deps.now()); }
  catch (error) { deps.log(`[mcp] http last use failed: ${errorCategory(error)}`); }
  request.signal.throwIfAborted();
  const writes = deps.writerEnabled() && CAPABILITIES.some((capability) => capability.kind === "write" && authorize(capability, deps.readSettings, grant).allowed);
  const context = defaultContext(readDb, settings, {
    audit: deps.audit(settings), log: deps.log, readSettings: deps.readSettings,
    caller: { caller: "token", tokenId: grant.tokenId, transport: "http" },
    grant, readGrant: deps.readGrant(readDb, deps.now), writeDb: writes ? deps.writeDb(settings) : null,
  });
  context.now = deps.now;
  const handler = deps.createHandler(() => {
    const server = buildServer(context, { version });
    server.server.registerCapabilities({ tools: { listChanged: false } });
    return server;
  }, {
    responseMode: "json", maxRequestBodySize: settings.http.max_body_bytes, maxSubscriptions: 0,
    onerror: (error) => deps.log(`[mcp] http transport error: ${errorCategory(error)}`),
  });
  const close = () => { void handler.close().catch((error: unknown) => deps.log(`[mcp] http close error: ${errorCategory(error)}`)); };
  try {
    const response = await handler.fetch(request, {
      authInfo: { token: "", clientId: String(grant.tokenId), scopes: [...grant.permissions], expiresAt: 253402300799 },
    });
    if (response.status === 413 || response.status >= 500) {
      void response.body?.cancel().catch(() => undefined);
      close();
      return response.status === 413 ? refusal(413, "payload_too_large") : refusal(500, "internal");
    }
    return releaseWithBody(response, close, deps.log);
  } catch (error) {
    close();
    throw error;
  }
}
