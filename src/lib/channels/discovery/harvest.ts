import type { ChannelLogger } from "@/lib/channels/types";

import { boardsFromHits, type DiscoveredBoard } from "./shared";
import type { DiscoveryStore } from "./store";

/**
 * Board discovery from a list of links, for sources that already hold the links (a job aggregator, a curated employer list)
 * instead of searching for them like `tavily` / `brave`. One step for every such source: keep the official ATS board URLs, drop
 * the boards `ats_boards` already lists, once per board, then write the candidates (tagged with the source) and mark the run.
 * A source runs it at most once per `intervalHours`; dry runs (no store) write nothing and only log what they found.
 */

export interface BoardLink {
  url: string;
  /** A hint for the company name; the candidate row shows it. */
  label: string | null;
}

export interface HarvestInput {
  /** The discovery source (its channel id): written to `found_by`, and the key of the run marker kept by `store`. */
  provider: string;
  links: readonly BoardLink[];
  /** `boardKey`s of the boards that need no candidate (see `knownBoardKeys`). */
  known: ReadonlySet<string>;
  /** null in dry runs: nothing is read or written. */
  store: DiscoveryStore | null;
  intervalHours: number;
  now: Date;
  logger: ChannelLogger;
}

export interface HarvestResult {
  /** `recent`: the last run is younger than the interval, nothing was done. */
  skipped: "recent" | null;
  candidates: DiscoveredBoard[];
  /** Candidates new to the table; null when nothing was written (skipped, or a dry run). */
  added: number | null;
}

export async function harvestBoardLinks(input: HarvestInput): Promise<HarvestResult> {
  const { provider, store, logger } = input;
  if (store) {
    const last = await store.lastRunAt();
    if (last && input.now.getTime() - last.getTime() < input.intervalHours * 3_600_000) {
      logger.info(`${provider} discovery ran recently; skipped`, { lastRunAt: last.toISOString(), intervalHours: input.intervalHours });
      return { skipped: "recent", candidates: [], added: null };
    }
  }
  const candidates = boardsFromHits(
    input.links.map((link) => ({ url: link.url, title: link.label })),
    input.known,
  );
  if (!store) {
    logger.info(`${provider} discovery dry run: candidates`, { links: input.links.length, boards: candidates.map((b) => `${b.ats}:${b.token}`) });
    return { skipped: null, candidates, added: null };
  }
  const added = await store.upsert(candidates.map((b) => ({ ats: b.ats, token: b.token, region: b.region, boardUrl: b.boardUrl, title: b.title, foundBy: provider })));
  await store.markRun();
  logger.info(`${provider} discovery done`, { links: input.links.length, candidates: candidates.length, newCandidates: added });
  return { skipped: null, candidates, added };
}
