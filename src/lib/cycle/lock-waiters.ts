/**
 * Cycles of this process waiting for the cycle lock (a scheduled cycle behind a cycle of only some channels). While one
 * waits, the control poller does not start another manual cycle: the poller takes requests within milliseconds, the
 * waiting cycle only tries the lock every `partial_cycle_wait.poll_seconds`, so a queue of clicks would otherwise keep
 * the lock from it until its wait ran out. Once it runs, the queued requests it covers end as done.
 */
let waiting = 0;

/** True while a cycle of this process waits for the lock. */
export function isCycleWaitingForLock(): boolean {
  return waiting > 0;
}

/** Count a waiting cycle; call the returned function (idempotent) when it stops waiting. */
export function startWaitingForLock(): () => void {
  waiting += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    waiting -= 1;
  };
}
