/**
 * Runner watchdog (ARCH-5). The container healthcheck only marks a runner `unhealthy`, and Docker does not restart on that;
 * `restart: unless-stopped` reacts to exits. So the runner ends itself when it has been unable to write its heartbeat for as
 * long as twice what the healthcheck tolerates (`RUNNER_HEALTH_MAX_AGE_SECONDS`): the container is then long unhealthy, and a host that slept (the clock jumps, the database connection drops) does not trigger an exit on waking.
 */
export interface HeartbeatWatchdog {
  /** A heartbeat was written. */
  succeeded(): void;
  /** A heartbeat write failed. Returns true when the failures have lasted `maxFailureSeconds` and the process should exit. */
  failed(): boolean;
}

export function createHeartbeatWatchdog(options: { maxFailureSeconds: number; now?: () => number }): HeartbeatWatchdog {
  const now = options.now ?? Date.now;
  let firstFailureAt: number | null = null;
  return {
    succeeded() {
      firstFailureAt = null;
    },
    failed() {
      const at = now();
      firstFailureAt ??= at;
      return at - firstFailureAt >= options.maxFailureSeconds * 1000;
    },
  };
}
