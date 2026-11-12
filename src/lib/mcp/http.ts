/** Token-authenticated, stateless HTTP serving. Preconditions run before credentials or pools are touched. */
import { createHmac, randomBytes } from "node:crypto";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import { authorize, liveMcpSettings } from "@/lib/agent-access/authorize";
import type { Permission } from "@/lib/agent-access/permissions";
import { agentTokenGrantReader, bearerAgentToken, verifyAgentToken } from "@/lib/agent-access/tokens";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { getMcpAuditRecorder, getMcpReadDb, getMcpWriteDb } from "@/lib/db/mcp-pools";
import { markAgentTokenUsed } from "@/lib/db/repos/agent-tokens";
import { LoginThrottle, throttleKey, type ThrottleLimits } from "@/lib/security/login-throttle";
import { passwordSettingUsable, readPasswordSetting } from "@/lib/security/password";
import { readWriterEnabled } from "@/lib/writer/settings";

import { version } from "../../../package.json";
import { stderrLine } from "./call-log";
import { errorCategory, type McpContext } from "./context";
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

interface HttpState { throttle: LoginThrottle; inFlight: number; logKey?: Buffer }
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

/** Owns the reader so disconnects can cancel it even while the consumer has locked the exposed stream. */
function managedBody(source: ReadableStream<Uint8Array>, finish: () => void, log: McpHttpDependencies["log"]) {
  const reader = source.getReader();
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cancel = async (close = true) => {
    if (stopped) return;
    stopped = true;
    if (close) controller.close();
    try { await reader.cancel(); }
    catch (error) { log(`[mcp] http stream error: ${errorCategory(error)}`); }
    finally { finish(); }
  };
  const body = new ReadableStream<Uint8Array>({
    start(output) { controller = output; },
    async pull() {
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) { stopped = true; finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (stopped) return;
        stopped = true;
        finish();
        log(`[mcp] http stream error: ${errorCategory(error)}`);
        controller.error(new Error("internal"));
      }
    },
    cancel() { return cancel(false); },
  }, { highWaterMark: 0 });
  return { body, cancel };
}

const contentLength = z.string().regex(/^\d+$/).transform(BigInt);

/**
 * The request's concurrency slot is freed once, when the response is done (sent, cancelled or refused) and no tool call it
 * started is still running. A disconnect ends the response but not a running call, so the call keeps the slot.
 */
export async function handleMcpHttpRequest(request: Request, deps: McpHttpDependencies = realDeps()): Promise<Response> {
  let endResponse: (() => void) | undefined;
  let responseOwnsSlot = false;
  let input: ReturnType<typeof managedBody> | undefined;
  let closeHandler: (() => void) | undefined;
  try {
    let settings: McpConfig;
    try { settings = deps.readSettings(); } catch { return refusal(404, "not_found"); }
    if (!settings.enabled || !settings.http.enabled) return refusal(404, "not_found");
    if (!passwordSettingUsable(deps.password())) return refusal(503, "web_password_required");
    if (request.method !== "POST") return mcpMethodNotAllowed();
    const key = throttleKey(request.headers.get("x-forwarded-for"));
    const current = state();
    const check = current.throttle.check(key);
    if (!check.allowed) return refusal(429, "too_many_attempts", { "Retry-After": String(check.retryAfterSeconds) }, { retry_after: check.retryAfterSeconds });
    if (current.inFlight >= settings.http.pool.max_concurrent) return refusal(503, "busy", { "Retry-After": "1" });
    current.inFlight++;
    let released = false;
    let responseDone = false;
    let runningCalls = 0;
    let output: ReturnType<typeof managedBody> | null = null;
    const abort = () => {
      void input?.cancel();
      void output?.cancel();
    };
    const releaseWhenIdle = () => {
      if (!released && responseDone && runningCalls === 0) {
        released = true;
        current.inFlight--;
      }
    };
    endResponse = () => {
      if (responseDone) return;
      responseDone = true;
      closeHandler?.();
      request.signal.removeEventListener("abort", abort);
      releaseWhenIdle();
    };
    const track = async <T>(call: () => Promise<T>): Promise<T> => {
      if (responseDone) throw new Error("request closed");
      runningCalls++;
      try { return await call(); }
      finally {
        runningCalls--;
        releaseWhenIdle();
      }
    };
    if (request.body) input = managedBody(request.body, () => {}, deps.log);
    request.signal.addEventListener("abort", abort, { once: true });
    request.signal.throwIfAborted();
    const forwarded = input ? new Request(request, { body: input.body, ...{ duplex: "half" } }) : request;
    const response = hygiene(await authenticatedResponse(forwarded, deps, settings, key, current.throttle, { adopt: (close) => { closeHandler = close; }, track }));
    if (request.signal.aborted) {
      await response.body?.cancel();
      request.signal.throwIfAborted();
    }
    if (!response.body) return response;
    output = managedBody(response.body, endResponse, deps.log);
    const result = new Response(output.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    responseOwnsSlot = true;
    return result;
  } catch (error) {
    deps.log(`[mcp] http error: ${errorCategory(error)}`);
    return refusal(500, "internal");
  } finally {
    void input?.cancel();
    if (!responseOwnsSlot) endResponse?.();
  }
}

const SDK_JSON_MODE_WARNING = "responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.";

/**
 * The SDK prints this notice on every construction in "json" mode. Responses here are plain JSON by design and a handler
 * is built per request, so exactly that message is dropped during the synchronous construction; every other warning
 * passes and console.warn is restored before returning.
 */
function createJsonHandler(create: McpHttpDependencies["createHandler"], ...args: Parameters<McpHttpDependencies["createHandler"]>) {
  const original = console.warn;
  console.warn = (...message: unknown[]) => {
    if (message.length !== 1 || message[0] !== SDK_JSON_MODE_WARNING) original.apply(console, message);
  };
  try { return create(...args); } finally { console.warn = original; }
}

/**
 * Builds a fresh SDK handler and server for every request, so one token's grant, results and audit context cannot reach
 * another request; the handler is closed when the response ends, and its tool calls run through `slot.track`.
 */
async function authenticatedResponse(
  request: Request, deps: McpHttpDependencies, settings: McpConfig, key: string, throttle: LoginThrottle,
  slot: { adopt: (close: () => void) => void; track: NonNullable<McpContext["track"]> },
): Promise<Response> {
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
    const logKey = state().logKey ??= randomBytes(32);
    deps.log(`[mcp] http request refused (401) source ${createHmac("sha256", logKey).update(key, "utf8").digest("hex").slice(0, 8)}`);
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
  const allowed = (permission: Permission) =>
    CAPABILITIES.some((capability) => capability.kind === "write" && capability.permission === permission && authorize(capability, deps.readSettings, grant).allowed);
  const writerWrites = allowed("writer:write") && deps.writerEnabled();
  const trackingWrites = allowed("tracking:write");
  const writeDb = writerWrites || trackingWrites ? deps.writeDb(settings) : null;
  const context = defaultContext(readDb, settings, {
    audit: deps.audit(settings), log: deps.log, readSettings: deps.readSettings,
    caller: { caller: "token", tokenId: grant.tokenId, transport: "http" },
    grant, readGrant: deps.readGrant(readDb, deps.now), writeDb: writerWrites ? writeDb : null, trackingWriteDb: trackingWrites ? writeDb : null,
  });
  context.now = deps.now;
  context.track = slot.track;
  const handler = createJsonHandler(deps.createHandler, () => {
    const server = buildServer(context, { version });
    server.server.registerCapabilities({ tools: { listChanged: false } });
    return server;
  }, {
    responseMode: "json", maxRequestBodySize: settings.http.max_body_bytes, maxSubscriptions: 0,
    onerror: (error) => deps.log(`[mcp] http transport error: ${errorCategory(error)}`),
  });
  slot.adopt(() => { void handler.close().catch((error: unknown) => deps.log(`[mcp] http close error: ${errorCategory(error)}`)); });
  const response = await handler.fetch(request, {
    authInfo: { token: "", clientId: String(grant.tokenId), scopes: [...grant.permissions], expiresAt: 253402300799 },
  });
  if (response.status === 413 || response.status >= 500) {
    void response.body?.cancel().catch(() => undefined);
    return response.status === 413 ? refusal(413, "payload_too_large") : refusal(500, "internal");
  }
  return response;
}
