/**
 * Quiet the web server's log about responses a browser gave up on.
 *
 * React's Flight renderer reports `Error: The destination stream closed early.` when the client closes
 * the connection while an RSC payload is still being written. That happens in normal use: a link
 * prefetch is cancelled when the row leaves the viewport or the page is left, and a filter change
 * supersedes the navigation before it finished. Next 16 only skips errors named AbortError, so it logs
 * this one as `⨯ Error` for every cancelled prefetch (dozens per e2e run, hundreds in a long session),
 * which buries real errors. Nothing failed on the server, so the entry is dropped here.
 *
 * Only this exact message is dropped. `The destination stream errored while writing data.` (a socket
 * error) and every other error still reach the log.
 */

export const CLIENT_CLOSED_EARLY_MESSAGE = "The destination stream closed early.";

/** Whether the arguments of a `console.error` call are Next's log line for a client that hung up mid-stream. */
export function isClientAbortLog(args: readonly unknown[]): boolean {
  return args.some((arg) => typeof arg === "object" && arg !== null && (arg as { message?: unknown }).message === CLIENT_CLOSED_EARLY_MESSAGE);
}

const INSTALLED = Symbol.for("job-radar.clientAbortFilter");

type ErrorLog = (...args: unknown[]) => void;

/** Wraps `target.error` so those lines are dropped. Safe to call twice; returns the function that restores the original. */
export function installClientAbortFilter(target: { error: ErrorLog } = console): () => void {
  const marked = target.error as ErrorLog & { [INSTALLED]?: ErrorLog };
  if (marked[INSTALLED]) return () => {};
  const original = target.error;
  const filtered: ErrorLog & { [INSTALLED]?: ErrorLog } = (...args) => {
    if (isClientAbortLog(args)) return;
    original.apply(target, args);
  };
  filtered[INSTALLED] = original;
  target.error = filtered;
  return () => {
    if (target.error === filtered) target.error = original;
  };
}
