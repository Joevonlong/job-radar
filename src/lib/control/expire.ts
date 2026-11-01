/**
 * Requests that carry the user's text (`SCRUBBED_PAYLOAD_KINDS`) never stay open: one pending or running longer than
 * `writer.yaml: timeout_seconds` is failed as `expired` and its payload scrubbed in the same UPDATE. The ai-worker calls
 * this before every poll, the runner at every cycle and the web whenever it reads such a request, so the text is cleared
 * even while no ai-worker runs. Idempotent and cheap; callers may run it concurrently.
 */
import { ConfigError, loadConfig } from "@/lib/config";
import { failExpiredControlRequests, SCRUBBED_PAYLOAD_KINDS } from "@/lib/db/repos/control-requests";
import type { Executor } from "@/lib/db/executor";
import { WRITER_DEFAULT_TIMEOUT_SECONDS } from "@/lib/config/schemas/writer";

/** `timeout_seconds` of writer.yaml, or its default while the file does not load. */
function writerTimeoutSeconds(): number {
  try {
    return loadConfig("writer").timeout_seconds;
  } catch (error) {
    if (error instanceof ConfigError) return WRITER_DEFAULT_TIMEOUT_SECONDS;
    throw error;
  }
}

/** Fail the expired requests of the scrubbed kinds; returns how many. */
export function expireScrubbedRequests(db: Executor, options: { timeoutSeconds?: number } = {}): Promise<number> {
  return failExpiredControlRequests(db, { kinds: SCRUBBED_PAYLOAD_KINDS, olderThanSeconds: options.timeoutSeconds ?? writerTimeoutSeconds() });
}
