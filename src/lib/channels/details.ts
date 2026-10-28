import { ChannelError } from "./errors";
import type { ChannelLogger } from "./types";

/**
 * Fewest detail requests a query must have made before "none of them could be read" is taken as a changed page layout
 * (or API shape) and fails the query. With fewer, a single odd page would throw away every list result the query
 * already read (raw postings are stored before parsing), so it only warns. This is a guard on the sanity of the check
 * itself, not a tuning knob for a collection: it is the same for every channel and stays a constant.
 */
export const MIN_DETAILS_FOR_LAYOUT_CHECK = 3;

export interface DetailReadCount {
  /** Detail requests sent for the query. */
  attempted: number;
  /** Of those, the ones whose answer could not be read (`parse`). */
  parseFailures: number;
}

/**
 * After a query's detail round: throws `parse` when every detail request of a large enough sample was unreadable, and
 * only warns when the sample is too small to tell a changed layout from one odd posting. Otherwise does nothing.
 */
export function checkDetailsReadable(logger: ChannelLogger, label: string, queryId: string, count: DetailReadCount): void {
  const { attempted, parseFailures } = count;
  if (attempted === 0 || parseFailures < attempted) return;
  if (attempted >= MIN_DETAILS_FOR_LAYOUT_CHECK) {
    throw new ChannelError("parse", `${label}: none of the ${attempted} detail pages could be read (page layout changed?)`);
  }
  logger.warn("no detail could be read, too few to tell a layout change; keeping the list data", { query: queryId, attempted });
}
