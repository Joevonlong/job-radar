let abandoned = 0;
/** How many pieces of work `withTimeout` gave up on (they may still hold a libuv thread). */
export const abandonedWorkCount = (): number => abandoned;

/** Thrown by `withTimeout` when the work did not settle in time. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/**
 * Settle with `work`, or reject with a TimeoutError after `ms`. The work itself cannot be cancelled (a stuck `readFile` under a
 * macOS permission prompt, a query on a dead socket), it is only no longer awaited: a loop that must keep going (the ai-worker's
 * heartbeat) stays alive instead of hanging behind it.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned += 1;
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  work.catch(() => {}); // a late rejection of abandoned work must not become an unhandled rejection
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
