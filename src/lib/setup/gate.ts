/**
 * The two decisions the pending setup drives, as pure functions (unit-tested; `src/proxy.ts` and the runner
 * only call them).
 */
import { firstOpenStep, type SetupStepId, type SetupStepStatus } from "./steps";

export const SETUP_PATH = "/setup";

/** Path prefixes a pending setup never redirects: the wizard itself, the login page (the wizard may need a login first), the API, Next's assets. */
const PASS_THROUGH = [SETUP_PATH, "/login", "/api", "/_next"] as const;

export interface RedirectInput {
  method: string;
  pathname: string;
  /** The request's Accept header (null when absent). */
  accept: string | null;
  pending: boolean;
  /** The steps done or skipped so far (the redirect opens the first open one). */
  steps?: Partial<Record<SetupStepId, { status: SetupStepStatus } | undefined>>;
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** A page navigation: an HTML document or a React Server Component payload (client-side navigation), or a client that accepts anything. */
function acceptsPage(accept: string | null): boolean {
  if (accept === null || accept.trim() === "") return true;
  const value = accept.toLowerCase();
  return value.includes("text/html") || value.includes("text/x-component") || value.includes("*/*");
}

/**
 * Where a request goes while the setup is pending: `/setup?step=<first open step>` for a page navigation (GET / HEAD of a
 * page), null for everything else (Server Actions are POST, `/api/*`, assets and files with an extension pass through).
 */
export function setupRedirect(input: RedirectInput): string | null {
  if (!input.pending) return null;
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (PASS_THROUGH.some((prefix) => underPrefix(input.pathname, prefix))) return null;
  const last = input.pathname.split("/").pop() ?? "";
  if (last.includes(".")) return null;
  if (!acceptsPage(input.accept)) return null;
  return `${SETUP_PATH}?step=${firstOpenStep(input.steps ?? {})}`;
}

/**
 * The runner's work the pending setup holds back: the scheduled cycles, the start-up catch-up (cycle, suggestions), the
 * weekly suggestions. A manual request (a control request, including the wizard's "run the first cycle") always runs.
 * The LinkedIn "recommended" read and the backup are not listed: the first only runs inside a cycle (a held-back cycle
 * holds it back too), the backup always runs.
 */
export const HELD_BACK_WORK = ["scheduled", "catchup", "suggest"] as const;
export type ScheduledWork = (typeof HELD_BACK_WORK)[number] | "manual";

export function shouldRunScheduled(work: ScheduledWork, setup: { pending: boolean }): boolean {
  if (work === "manual") return true;
  return !setup.pending;
}
