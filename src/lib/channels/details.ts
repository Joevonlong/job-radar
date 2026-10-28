import { ChannelError } from "./errors";
import type { ChannelLogger } from "./types";

/**
 * Fewest detail requests a query must have made before "none of them could be read" is taken as a changed page layout
 * (or API shape). With fewer, a single odd page would count as a layout change, so it only warns. This is a guard on the
 * sanity of the check itself, not a tuning knob for a collection: it is the same for every channel and stays a constant.
 * A channel that may send fewer detail requests per query (`max_details_per_query`) uses that number instead.
 */
export const MIN_DETAILS_FOR_LAYOUT_CHECK = 3;

export interface DetailReadCount {
  /** Detail requests sent for the query. */
  attempted: number;
  /** Of those, the ones whose answer could not be read (`parse`). */
  parseFailures: number;
  /** Most detail requests the channel sends per query (`max_details_per_query`). */
  maxPerQuery: number;
}

/**
 * After a query's detail round: the `parse` error of a changed layout when every detail request of a large enough sample
 * was unreadable, or null. The caller hands it on with the list results (raw postings are stored before parsing), so the
 * run still counts as a `parse` failure. With too small a sample it only warns and returns null.
 */
export function detailLayoutError(logger: ChannelLogger, label: string, queryId: string, count: DetailReadCount): ChannelError | null {
  const { attempted, parseFailures, maxPerQuery } = count;
  if (attempted === 0 || parseFailures < attempted) return null;
  const minimum = Math.max(1, Math.min(MIN_DETAILS_FOR_LAYOUT_CHECK, maxPerQuery));
  if (attempted >= minimum) {
    return new ChannelError("parse", `${label}: none of the ${attempted} detail pages could be read (page layout changed?)`);
  }
  logger.warn("no detail could be read, too few to tell a layout change; keeping the list data", { query: queryId, attempted });
  return null;
}
