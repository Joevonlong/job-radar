/** Data for the /interests page (server only). */
import { createHash } from "node:crypto";

import { ConfigError, loadConfig, reloadConfig, type InterestsConfig } from "@/lib/config";
import type { SavedView } from "@/lib/config/schemas/interests";

import { countSignalsByCategory, getDb, type CategorySignalCount } from "@/lib/db";

import { loadMarket } from "@/lib/market";

import { presetOptions, type PresetOption } from "./presets";
import { describeWatchedCompanies } from "./service";
import { loadViewTrends } from "./view-trends";
import type { WatchedCompanyView } from "./types";
import { configToDraft, type VocabularyDraft } from "./vocabulary-draft";

export interface InterestsPageData {
  /** Null when interests.yaml cannot be loaded (see `loadError`). */
  vocabulary: { draft: VocabularyDraft; /** Hash of the vocabulary part: the form restarts when it changes. */ hash: string } | null;
  /** Stored signals and jobs per category id (the delete dialog says what it hides); null when the database cannot be read. */
  signalCounts: Record<string, CategorySignalCount> | null;
  views: SavedView[];
  watched: WatchedCompanyView[];
  /** Per view id, new jobs per day over the last `ui.yaml: trend_cycles` days (oldest first); empty when the database cannot be read. */
  trends: Record<string, number[]>;
  loadError: string | null;
  /** The presets of the add dialog (signal-presets.yaml, word lists of English + the market's language); empty when the file cannot be read. */
  presets: PresetOption[];
  /** `limits.ai_review_without_candidates` (a keyword category without words relies on it). */
  aiReviewWithoutCandidates: boolean;
}

export function vocabularyHash(config: InterestsConfig): string {
  return createHash("sha256")
    .update(JSON.stringify({ signals: config.signals, cap: config.bonus_cap }))
    .digest("hex")
    .slice(0, 16);
}

export async function loadInterestsPage(): Promise<InterestsPageData> {
  let config: InterestsConfig;
  try {
    config = reloadConfig("interests");
  } catch (error) {
    if (error instanceof ConfigError) return { vocabulary: null, signalCounts: null, views: [], watched: [], trends: {}, loadError: error.message, presets: [], aiReviewWithoutCandidates: true };
    throw error;
  }
  const trends = await loadTrends(config.views);
  return {
    vocabulary: { draft: configToDraft(config), hash: vocabularyHash(config) },
    signalCounts: await loadSignalCounts(),
    views: config.views,
    watched: await describeWatchedCompanies(config.watched_companies),
    trends,
    loadError: null,
    presets: loadPresets(),
    aiReviewWithoutCandidates: config.limits.ai_review_without_candidates,
  };
}

/** The presets with the word lists of English and the market's home language; none when the file or the market cannot be read. */
function loadPresets(): PresetOption[] {
  let presets;
  try {
    presets = reloadConfig("signalPresets").presets;
  } catch {
    return [];
  }
  let homeLanguage: string | null = null;
  try {
    homeLanguage = loadMarket().homeLanguage;
  } catch {
    // no market: English only
  }
  return presetOptions(presets, homeLanguage);
}

async function loadSignalCounts(): Promise<Record<string, CategorySignalCount> | null> {
  try {
    return Object.fromEntries(await countSignalsByCategory(getDb()));
  } catch {
    return null; // no database: the delete dialog says the count is unknown
  }
}

/** The sparkline numbers of every view (one aggregated query); the window length is `ui.yaml: trend_cycles` (days here, the same "how long a trend line is" knob as the summary blocks). */
async function loadTrends(views: readonly SavedView[]): Promise<Record<string, number[]>> {
  if (views.length === 0) return {};
  try {
    const days = reloadConfig("ui").trend_cycles;
    const timezone = loadConfig("schedule").timezone;
    return Object.fromEntries(await loadViewTrends(getDb(), views, { timezone, now: new Date(), days }));
  } catch {
    // a broken ui.yaml / schedule.yaml or no database: the views simply have no sparkline
    return {};
  }
}
