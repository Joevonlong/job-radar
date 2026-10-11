/**
 * The login and sign-out endpoints (`/api/auth/login`, `/api/auth/logout`, `/api/auth/logout-all`), as request ->
 * response functions so the route files stay one line and the tests can call them directly. Server / Node only.
 *
 * Login: a form POST (`password`, `next`). The Host / Origin check of the proxy has already required a same-origin
 * request. Too many failures -> 429 with `Retry-After` (`login-throttle.ts`); a wrong password -> 401
 * `{"error":"invalid_password"}` (one answer for every reason, and one scrypt run every time); right -> the session
 * cookie and 303 to `next` (or 200 `{"next": ...}` when the client asked for JSON). The password, the cookie value and
 * the client address are never logged.
 *
 * Sign out everywhere: raises the session generation (every session ends, this one too) and clears this browser's cookie.
 */
import { createHash } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getConfigDir } from "@/lib/config/paths";

import { LOGIN_PATH, safeNextPath } from "./auth-gate";
import { LoginThrottle, throttleKey, type ThrottleLimits } from "./login-throttle";
import { passwordVersion, readPasswordSetting, verifyPassword } from "./password";
import { bumpSessionGeneration, createSessionToken, isHttpsRequest, readSessionGeneration, sessionCookieName, sessionSecret } from "./session";
import { readWebAccess, sessionIsValid, sessionToken } from "./web-access";
import { webAccessSettings, type WebAccessSettings } from "./web-access-settings";

type Env = Readonly<Record<string, string | undefined>>;

/** Largest login form accepted (bytes). */
const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

const formSchema = z.object({
  password: z.string().max(1024),
  next: z.string().max(2000).optional(),
});

function limitsOf(settings: WebAccessSettings): ThrottleLimits {
  return {
    maxFailures: settings.login_max_failures,
    windowMs: settings.login_window_minutes * 60_000,
    lockoutMs: settings.login_lockout_minutes * 60_000,
    globalMaxFailures: settings.global_max_failures,
    globalDelayMs: settings.global_delay_seconds * 1000,
  };
}

/** One throttle per web process. */
let throttle = new LoginThrottle();
/** Logins whose scrypt run is in progress (each one takes 128 MiB for a moment). */
let inFlight = 0;

/** A fresh throttle (tests), optionally with a fake clock. */
export function resetLoginThrottle(now?: () => number): void {
  throttle = new LoginThrottle(now);
  inFlight = 0;
}

/** The session cookie's attributes: `Secure` over https (required by the `__Host-` name), never a `Domain`. */
function cookieOptions(https: boolean, maxAge: number) {
  return { name: sessionCookieName(https), httpOnly: true, sameSite: "lax", path: "/", maxAge, secure: https } as const;
}

function wantsJson(request: NextRequest): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("application/json");
}

/** The short hash of a throttle key for the log (never the address itself). */
function keyTag(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

/**
 * The request body as text, read as a stream and given up (the stream cancelled) as soon as it passes `limit` bytes:
 * null then. A missing or lying `Content-Length` cannot make the server buffer more than that.
 */
export async function readCappedBody(request: Request, limit: number = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(request: NextRequest): Promise<z.infer<typeof formSchema> | null> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded") && !type.startsWith("multipart/form-data")) return null;
  try {
    const text = await readCappedBody(request);
    if (text === null) return null;
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(text, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
      const parsed = formSchema.safeParse({ password: form.get("password"), next: form.get("next") ?? undefined });
      return parsed.success ? parsed.data : null;
    }
    const params = new URLSearchParams(text);
    const parsed = formSchema.safeParse({ password: params.get("password"), next: params.get("next") ?? undefined });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function redirectOrJson(request: NextRequest, next: string): NextResponse {
  return wantsJson(request) ? NextResponse.json({ next }, { headers: NO_STORE }) : new NextResponse(null, { status: 303, headers: { ...NO_STORE, location: next } });
}

function tooMany(seconds: number): NextResponse {
  return NextResponse.json({ error: "too_many_attempts", retry_after: seconds }, { status: 429, headers: { ...NO_STORE, "retry-after": String(seconds) } });
}

export async function handleLogin(request: NextRequest, env: Env = process.env, now: () => Date = () => new Date()): Promise<NextResponse> {
  const setting = readPasswordSetting(env);
  // nothing to log in to
  if (setting === null) return redirectOrJson(request, safeNextPath((await readForm(request))?.next ?? null));
  const settings = webAccessSettings();
  const limits = limitsOf(settings);
  const key = throttleKey(request.headers.get("x-forwarded-for"));
  // somebody already signed in (a second tab, a session about to expire) is not held up by a spray from elsewhere
  const signedIn = sessionIsValid(sessionToken(request.headers, request.cookies), setting, env, now());
  // the limits come before any scrypt run
  const allowed = throttle.check(key, { skipGlobal: signedIn });
  if (!allowed.allowed) return tooMany(allowed.retryAfterSeconds);
  if (inFlight >= settings.max_concurrent_logins) return tooMany(1);
  if (setting.kind === "hash" && setting.parsed === null) {
    // a configured hash this code cannot read: the gate stays shut, nobody can log in (never "no password")
    console.error("[auth] JOB_RADAR_WEB_PASSWORD_HASH is not a valid hash: run pnpm web:password again (pnpm run doctor, web.access)");
    return NextResponse.json({ error: "password_misconfigured" }, { status: 500, headers: NO_STORE });
  }
  // the slot is taken before the first await, so concurrent requests cannot all slip past the cap
  inFlight += 1;
  let form: z.infer<typeof formSchema> | null;
  let ok: boolean;
  try {
    // the body is read only now, behind the limits, and never past MAX_BODY_BYTES
    form = await readForm(request);
    // always one scrypt run, even for a malformed form
    ok = await verifyPassword(form?.password ?? "", setting);
  } finally {
    inFlight -= 1;
  }
  const next = safeNextPath(form?.next ?? null);
  if (!ok || form === null) {
    const { locked, globalDelaySeconds } = throttle.recordFailure(key, limits);
    if (locked) console.warn(`[auth] too many failed logins (source ${keyTag(key)}): locked for ${settings.login_lockout_minutes} min`);
    if (globalDelaySeconds !== null) {
      console.warn(`[auth] ${settings.global_max_failures}+ failed logins from all sources within ${settings.login_window_minutes} min: every login now waits ${globalDelaySeconds} s (signed-in browsers excepted)`);
    }
    return NextResponse.json({ error: "invalid_password" }, { status: 401, headers: NO_STORE });
  }
  let secret: Buffer;
  let generation: number;
  try {
    const configDir = getConfigDir();
    secret = sessionSecret(configDir, env);
    generation = readSessionGeneration(configDir);
  } catch (error) {
    console.error("[auth] cannot read or create the session secret:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "session_unavailable" }, { status: 500, headers: NO_STORE });
  }
  throttle.recordSuccess(key);
  const maxAge = settings.session_days * 86_400;
  const token = createSessionToken(secret, passwordVersion(setting, secret), maxAge, now(), generation);
  const response = redirectOrJson(request, next);
  response.cookies.set({ ...cookieOptions(isHttpsRequest(request.headers), maxAge), value: token });
  return response;
}

function signedOut(request: NextRequest, location: string): NextResponse {
  const response = new NextResponse(null, { status: 303, headers: { ...NO_STORE, location } });
  response.cookies.set({ ...cookieOptions(isHttpsRequest(request.headers), 0), value: "" });
  return response;
}

export function handleLogout(request: NextRequest): NextResponse {
  return signedOut(request, LOGIN_PATH);
}

/** The settings page, where the button is: a request from this machine stays signed in (no session needed) and goes back there. */
const SETTINGS_PATH = "/settings";

export function handleSignOutEverywhere(request: NextRequest, env: Env = process.env): NextResponse {
  try {
    const generation = bumpSessionGeneration(getConfigDir());
    console.warn(`[auth] every web session was ended (sign out everywhere, session generation ${generation})`);
  } catch (error) {
    console.error("[auth] cannot write the session generation:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "session_unavailable" }, { status: 500, headers: NO_STORE });
  }
  const local = readWebAccess(request.headers, request.cookies, env).localExempt;
  return signedOut(request, local ? SETTINGS_PATH : LOGIN_PATH);
}
