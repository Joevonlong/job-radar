/**
 * The login gate as pure functions (unit-tested; `src/proxy.ts` calls them after the host check and before the setup
 * redirect).
 *
 * - No password configured: everything passes (the behaviour without the feature).
 * - Always open: the health check, the login page (GET) and the login endpoint (POST).
 * - A local request (see `local-request.ts`) passes; so does a valid session cookie.
 * - Otherwise a page navigation (GET / HEAD accepting HTML) is sent to `/login?next=<path>` (303), and everything else
 *   (Server Actions, API calls, client-side navigations, files) gets 401 with `{"error":"login_required"}`.
 */
export const LOGIN_PATH = "/login";
export const LOGIN_API_PATH = "/api/auth/login";
export const LOGOUT_API_PATH = "/api/auth/logout";
export const LOGOUT_ALL_API_PATH = "/api/auth/logout-all";

const READ = ["GET", "HEAD"] as const;

/**
 * Reachable without a session, each with the methods it is open for. A Server Action is a POST to the page it runs on, so
 * the login page is open for GET / HEAD only (an action posted to `/login` needs a session like any other). `/api/auth/logout`
 * is not listed: it needs a session.
 */
const PUBLIC_ROUTES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["/api/health", READ],
  [LOGIN_PATH, READ],
  [LOGIN_API_PATH, ["POST"]],
  ["/favicon.ico", READ],
]);

export type AuthDecision = "pass" | "login_redirect" | "unauthorized";

export interface AuthInput {
  pathname: string;
  method: string;
  /** The request's Accept header (null when absent). */
  accept: string | null;
  /** A local request that may skip the login (`localExemption`). */
  local: boolean;
  /** A password is configured. */
  configured: boolean;
  /** The request carries a valid session cookie. */
  sessionValid: boolean;
}

/** Whether a request (path and method) is reachable without a session. */
export function isPublicRoute(pathname: string, method: string): boolean {
  return PUBLIC_ROUTES.get(pathname)?.includes(method.toUpperCase()) ?? false;
}

function isHtmlNavigation(method: string, accept: string | null): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  return (accept ?? "").toLowerCase().includes("text/html");
}

export function authDecision(input: AuthInput): AuthDecision {
  if (!input.configured) return "pass";
  if (isPublicRoute(input.pathname, input.method)) return "pass";
  if (input.local || input.sessionValid) return "pass";
  return isHtmlNavigation(input.method, input.accept) ? "login_redirect" : "unauthorized";
}

const MAX_NEXT_CHARS = 2000;

/**
 * The `next` target after a login: an internal path only. It must start with a single `/` (not `//`, not `/\`), hold no
 * backslash or control character, and not lead back to the login or into the API. Anything else becomes `/`.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NEXT_CHARS) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  const pathname = value.split(/[?#]/)[0] ?? "";
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return "/";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "/";
  return value;
}

/** Where a page navigation without a session goes: the login page, coming back to the requested path and query. */
export function loginRedirectTarget(pathname: string, search: string): string {
  const next = safeNextPath(`${pathname}${search}`);
  return next === "/" ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}
