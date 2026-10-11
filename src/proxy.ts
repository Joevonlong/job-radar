/**
 * Runs in front of every request except Next's static build files.
 *
 * 1. Host allowlist (DNS rebinding): a request addressed to a host name that is not allowed (`Host`, `X-Forwarded-Host`
 *    and, when present, `Origin`) is refused with 421 and a plain-text explanation, before any page, API route or Server
 *    Action runs. The decision is `checkRequestHosts` (pure, unit-tested); the list comes from `currentAllowlist`.
 * 2. Optional web password (`.env`: JOB_RADAR_WEB_PASSWORD_HASH / JOB_RADAR_WEB_PASSWORD): without a local exemption or a
 *    valid session cookie, a page navigation goes to `/login?next=<path>` (303) and anything else gets 401 JSON. The
 *    decision is `authDecision` (pure, unit-tested); the request's standing is `readWebAccess`. No password: no gate.
 * 3. While the first-run setup is pending, a page navigation goes to the wizard (`/setup?step=<first open step>`).
 *    The decision is `setupRedirect` (pure, unit-tested); the state is read from setup.yaml with an mtime cache. Proxy runs
 *    in the Node.js runtime (Next 16), so it reads the file directly. The wizard, API routes, Next's assets, files and
 *    Server Actions (POST) are never redirected; an unreadable setup.yaml counts as completed (nobody is locked into the wizard).
 */
import { NextResponse, type NextRequest } from "next/server";

import { currentAllowlist } from "@/lib/security/allowed-hosts";
import { authDecision, loginRedirectTarget } from "@/lib/security/auth-gate";
import { checkRequestHosts, refusalMessage } from "@/lib/security/host-allowlist";
import { readWebAccess } from "@/lib/security/web-access";
import { setupRedirect } from "@/lib/setup/gate";
import { readSetupState } from "@/lib/setup/state";

/** 421 Misdirected Request: the request was sent to a name this server does not answer for. */
const REFUSED_STATUS = 421;

export function proxy(request: NextRequest): NextResponse {
  const hosts = checkRequestHosts(
    {
      method: request.method,
      host: request.headers.get("host"),
      forwardedHost: request.headers.get("x-forwarded-host"),
      origin: request.headers.get("origin"),
    },
    currentAllowlist(),
  );
  if (!hosts.ok) {
    return new NextResponse(refusalMessage(hosts), {
      status: REFUSED_STATUS,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }

  const gate = loginGate(request);
  if (gate !== null) return gate;

  const status = readSetupState();
  const target = setupRedirect({
    method: request.method,
    pathname: request.nextUrl.pathname,
    accept: request.headers.get("accept"),
    pending: status.pending,
    steps: status.state?.steps ?? {},
  });
  return target === null ? NextResponse.next() : NextResponse.redirect(new URL(target, request.url));
}

/** The login gate (step 2): null to go on, or the redirect / refusal. */
function loginGate(request: NextRequest): NextResponse | null {
  const access = readWebAccess(request.headers, request.cookies);
  const decision = authDecision({
    pathname: request.nextUrl.pathname,
    method: request.method,
    accept: request.headers.get("accept"),
    local: access.localExempt,
    configured: access.password !== null,
    sessionValid: access.sessionValid,
  });
  if (decision === "pass") return null;
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (decision === "login_redirect") {
    // Next requires an absolute Location from a proxy and sends a same-origin one on as a relative path
    const location = new URL(loginRedirectTarget(request.nextUrl.pathname, request.nextUrl.search), request.url);
    return new NextResponse(null, { status: 303, headers: { ...headers, location: location.toString() } });
  }
  return NextResponse.json({ error: "login_required" }, { status: 401, headers });
}

export const config = {
  // Everything (pages, /setup, /api, Server Actions, exports) but Next's immutable build output: the host check must
  // cover every route. `setupRedirect` itself leaves the wizard, the API, assets and files alone.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
