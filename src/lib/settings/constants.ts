/** The browser asks the server again this often while a request or a reload acknowledgement is still pending. */
export const STATUS_POLL_MS = 2000;
/** `/sources` refreshes itself this often while the latest cycle is still running. */
export const SOURCES_REFRESH_MS = 5000;
/** The runner counts as offline when its newest heartbeat is older than this many heartbeat intervals. */
export const HEARTBEAT_STALE_FACTOR = 3;
/** How many control requests the settings page lists. */
export const RECENT_REQUESTS = 5;
/** Runs listed per channel card on `/sources`. */
export const RUNS_PER_CHANNEL = 10;
/** The translation tab stops waiting for the ai-worker after this long (it is probably offline: see /sources). */
export const TRANSLATE_WAIT_MAX_MS = 10 * 60 * 1000;
/** The breakdown card stops waiting for the ai-worker after this long (it is probably offline: see /sources). */
export const BREAKDOWN_WAIT_MAX_MS = 10 * 60 * 1000;
/** A trigger button stops polling its request after this long and says the runner / ai-worker has not answered. */
export const TRIGGER_WAIT_MAX_MS = 10 * 60 * 1000;
/** The sidebar's cycle status asks again this often while nothing is running (while one runs it uses `STATUS_POLL_MS`). */
export const SHELL_IDLE_POLL_MS = 30_000;
