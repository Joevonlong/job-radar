import { createProcessLogger } from "./process-logger";

const log = createProcessLogger({ fields: { component: "web" } });

/** Error codes can be on a database wrapper's cause. Never read message, stack, query or payload. */
function failureCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)) return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
  return undefined;
}

/** Safe diagnostics for a failure translated into a friendly action result. */
export function logActionFailure(action: string, error: unknown): void {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name) ? error.name : "Error";
  const code = failureCode(error);
  log.warn("action failed", { action, name, ...(code === undefined ? {} : { code }) });
}
