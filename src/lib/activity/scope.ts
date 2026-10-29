import { activityErrorCode } from "./error-codes";
import type { SpanHandle, TerminalStatus } from "./types";

/** Synchronous bookkeeping only; the caller closes in finally around the existing business awaits. */
export function spanScope(span: SpanHandle, initial: TerminalStatus = "failed", reason?: string) {
  let status = initial;
  let reasonCode = reason;
  let closed = false;
  return {
    set(next: TerminalStatus, code?: string): void { status = next; reasonCode = code; },
    error(error: unknown): void { status = "failed"; reasonCode = activityErrorCode(error); },
    close(): void {
      if (closed) return;
      closed = true;
      span.finish(status, reasonCode === undefined ? undefined : { reasonCode });
    },
  };
}
