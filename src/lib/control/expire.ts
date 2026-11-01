/**
 * Requests that carry the user's text (`SCRUBBED_PAYLOAD_KINDS`) never stay open: one queued longer than
 * `writer.yaml: queue_timeout_seconds`, or running longer than `timeout_seconds + expiry_grace_seconds`, is failed as
 * `expired` and its payload scrubbed in the same UPDATE. The margin lets the worker's own timeout (`timeout_seconds` from
 * the claim) end a live request first; the expiry is for a worker that died or hangs. The ai-worker calls this before
 * every poll, the runner at every cycle and the web whenever it reads or queues such a request, so the text is cleared
 * even while no ai-worker runs. Idempotent and cheap; callers may run it concurrently.
 */
import { ConfigError, loadConfig, type WriterConfig } from "@/lib/config";
import { failExpiredControlRequests, SCRUBBED_PAYLOAD_KINDS } from "@/lib/db/repos/control-requests";
import type { Executor } from "@/lib/db/executor";
import { WRITER_DEFAULT_EXPIRY_GRACE_SECONDS, WRITER_DEFAULT_QUEUE_TIMEOUT_SECONDS, WRITER_DEFAULT_TIMEOUT_SECONDS } from "@/lib/config/schemas/writer";

type ExpirySettings = Pick<WriterConfig, "timeout_seconds" | "expiry_grace_seconds" | "queue_timeout_seconds">;

/** The expiry keys of writer.yaml, or their defaults while the file does not load. */
function writerExpirySettings(): ExpirySettings {
  try {
    return loadConfig("writer");
  } catch (error) {
    if (error instanceof ConfigError) {
      return { timeout_seconds: WRITER_DEFAULT_TIMEOUT_SECONDS, expiry_grace_seconds: WRITER_DEFAULT_EXPIRY_GRACE_SECONDS, queue_timeout_seconds: WRITER_DEFAULT_QUEUE_TIMEOUT_SECONDS };
    }
    throw error;
  }
}

/** Fail the expired requests of the scrubbed kinds; returns how many. `settings` defaults to writer.yaml. */
export function expireScrubbedRequests(db: Executor, options: { settings?: ExpirySettings } = {}): Promise<number> {
  const settings = options.settings ?? writerExpirySettings();
  return failExpiredControlRequests(db, {
    kinds: SCRUBBED_PAYLOAD_KINDS,
    pendingSeconds: settings.queue_timeout_seconds,
    runningSeconds: settings.timeout_seconds + settings.expiry_grace_seconds,
  });
}
