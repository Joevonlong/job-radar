import { berlinDesignNetworkSettingsSchema, loadCompanies, type BerlinDesignNetworkSettings, type CompaniesConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";

import { issuePaths } from "../ats/envelope";
import { harvestBoardLinks } from "../discovery/harvest";
import { knownBoardKeys } from "../discovery/shared";
import { createDbDiscoveryStore, type DiscoveryStore } from "../discovery/store";
import { ChannelError } from "../errors";
import type { Channel, ChannelContext, NormalizedPostingDraft, RawPostingInput, SearchQuery } from "../types";
import { fetchJobsPage, linksFromPage } from "./client";

export const BERLIN_DESIGN_NETWORK_CHANNEL_ID = "berlin_design_network";

export { fetchJobsPage, jobsUrl, linksFromPage } from "./client";

export interface BerlinDesignNetworkDeps {
  /** Current boards (re-read on every collect, so edits apply to the next cycle). */
  companies(): CompaniesConfig;
  /** Candidate storage and run marker; only asked for in real runs. */
  store(): DiscoveryStore;
  now?(): Date;
}

export const defaultBerlinDesignNetworkDeps: BerlinDesignNetworkDeps = {
  companies: () => loadCompanies(),
  store: () => createDbDiscoveryStore(getDb(), BERLIN_DESIGN_NETWORK_CHANNEL_ID),
};

function settingsOf(ctx: ChannelContext): BerlinDesignNetworkSettings {
  const parsed = berlinDesignNetworkSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    throw new ChannelError("unknown", `sources.yaml sources.berlin_design_network is not usable (${issuePaths(parsed.error)})`, { retryable: false });
  }
  return parsed.data;
}

/**
 * Board discovery from the Berlin Design Network job list: its apply links to official ATS boards become candidates on
 * /sources/registry. No postings are stored (the list has no descriptions), so `collect` returns nothing. One request per run, at
 * most once per `interval_hours`; a failed run writes nothing and leaves the marker alone, so the next cycle tries again.
 */
export function createBerlinDesignNetworkChannel(deps: BerlinDesignNetworkDeps = defaultBerlinDesignNetworkDeps): Channel {
  return {
    id: BERLIN_DESIGN_NETWORK_CHANNEL_ID,
    family: "ats",
    kind: "api",
    usesQueries: false,
    // a snapshot of the current list, not a window that can be stretched
    supportsCatchUp: () => false,
    async collect(_query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = settingsOf(ctx);
      const now = (deps.now ?? (() => new Date()))();
      // dry runs (no cycle id) write nothing, so they neither read nor update the run marker
      const store = ctx.cycle.id === null ? null : deps.store();
      if (store) {
        const last = await store.lastRunAt();
        if (last && now.getTime() - last.getTime() < settings.interval_hours * 3_600_000) {
          ctx.logger.info("berlin_design_network discovery ran recently; skipped", { lastRunAt: last.toISOString(), intervalHours: settings.interval_hours });
          return [];
        }
      }
      ctx.signal.throwIfAborted();
      const html = await fetchJobsPage(ctx, settings);
      const { total, links, invalid } = linksFromPage(html);
      if (invalid > 0) ctx.logger.warn("berlin_design_network entries of an unexpected shape skipped", { count: invalid });
      const result = await harvestBoardLinks({
        provider: BERLIN_DESIGN_NETWORK_CHANNEL_ID,
        links,
        known: knownBoardKeys(deps.companies()),
        store,
        intervalHours: settings.interval_hours,
        now,
        logger: ctx.logger,
      });
      ctx.logger.info("berlin_design_network run done", { jobs: total, links: links.length, boards: result.candidates.length, newCandidates: result.added });
      return [];
    },
    parse(): NormalizedPostingDraft {
      throw new ChannelError("parse", `${BERLIN_DESIGN_NETWORK_CHANNEL_ID} discovers boards; it stores no postings`);
    },
  };
}

export const berlinDesignNetworkChannel: Channel = createBerlinDesignNetworkChannel();
