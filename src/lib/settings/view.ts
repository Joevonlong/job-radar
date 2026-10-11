/** Data for the /settings page (server only): the five config files as form drafts, the live status, the channel choices. */
import { CHANNEL_CONFIG_TABLE, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { ConfigError, configSourcePath, displayConfigPath, firstConfigProblem, getUserConfigPath, hashConfigText, readConfigText, reloadConfig, type ChannelsConfig } from "@/lib/config";
import { aiDisclosure, type AiDisclosureRow } from "@/lib/ai/disclosure";
import type { AiProviderState } from "@/lib/ai/provider-state";
import { scorePromptFor } from "@/lib/ai/prompts/score";
import { getDb, getDbNow } from "@/lib/db";
import { countScoresAtPromptVersion } from "@/lib/db/repos/scores";
import { loadPipeline } from "@/lib/market";
import { loadTelegramStatus, type TelegramStatusView } from "@/lib/notify/telegram-status";
import { scoreLanguageOf } from "@/lib/scoring/score-task";
import { loadAiProviderViews } from "@/lib/sources/load";

import { toCatalogView, type CatalogView } from "./catalog-view";
import { configToDraft } from "./draft";
import { loadControlStatus } from "./status";
import type { ControlStatus } from "./status-schema";
import { SETTINGS_FORMS, type SettingsForm } from "./tabs";
import type { WorkflowView } from "./workflow/types";
import { loadWorkflowView } from "./workflow/view";
import type { SettingsSection } from "./types";

export interface SettingsPageData {
  sections: SettingsSection[];
  /** Null when the database cannot be reached: no live status, no way to leave requests for the runner. */
  status: ControlStatus | null;
  /** Channels a manual cycle may be limited to: the enabled ones. */
  channelChoices: string[];
  /** Per AI provider id whether it can run now (empty when the database or ai.yaml cannot be read). */
  providerStates: Record<string, AiProviderState>;
  /** The model catalog for the AI tab; null when models.yaml cannot be read (see `catalogError`). */
  catalog: CatalogView | null;
  /** First line of why models.yaml cannot be read; null when it can. */
  catalogError: string | null;
  /** The application workflow panel (status table, categories). */
  workflow: WorkflowView;
  /** Current scores that changed scoring criteria would re-score; null when it cannot be told (no database, no market). */
  criteriaImpact: number | null;
  /** Per AI task the providers that may receive job text, from the saved ai.yaml; null when ai.yaml cannot be read. */
  aiDisclosure: AiDisclosureRow[] | null;
  /** Telegram on the Notifications tab: whether the bot is set up (names only, never a value), push on/off, last test. */
  telegram: TelegramStatusView;
}

/** How many current scores carry the version the scoring prompt has now (all of them go stale when the criteria change). */
async function loadCriteriaImpact(): Promise<number | null> {
  try {
    const ai = reloadConfig("ai");
    const version = scorePromptFor(scoreLanguageOf(loadPipeline()), { criteria: ai.scoring.criteria }).version;
    return await countScoresAtPromptVersion(getDb(), version);
  } catch {
    return null;
  }
}

function loadSection(tab: SettingsForm): SettingsSection {
  const files = { file: displayConfigPath(getUserConfigPath(tab)), ...(tab === "ai" ? { catalogFile: displayConfigPath(configSourcePath("models")) } : {}) };
  let hash = "";
  try {
    hash = hashConfigText(readConfigText(tab));
  } catch {
    // unreadable file: reported through loadError below
  }
  try {
    return { tab, hash, draft: configToDraft(tab, reloadConfig(tab)), loadError: null, ...files };
  } catch (error) {
    return { tab, hash, draft: null, loadError: error instanceof Error ? error.message : "unknown error", ...files };
  }
}

/** Ids of the channels switched on in sources.yaml. */
export function enabledChannelIds(config: ChannelsConfig): string[] {
  return (Object.keys(CHANNEL_CONFIG_TABLE) as ConfiguredChannelId[]).filter((id) => settingsFromConfig(id, config).enabled);
}

export async function loadSettingsPage(): Promise<SettingsPageData> {
  const sections = SETTINGS_FORMS.map(loadSection);
  let status: ControlStatus | null = null;
  try {
    status = await loadControlStatus(getDb());
  } catch {
    status = null;
  }
  let channelChoices: string[] = [];
  try {
    channelChoices = enabledChannelIds(reloadConfig("channels"));
  } catch {
    // an invalid sources.yaml is reported by its tab
  }
  let providerStates: Record<string, AiProviderState> = {};
  try {
    const db = getDb();
    const views = await loadAiProviderViews(db, await getDbNow(db));
    providerStates = Object.fromEntries(views.map((view) => [view.id, view.state]));
  } catch {
    // no marks: the dropdowns still work
  }
  // the web process has no config watcher: read models.yaml fresh on every request
  let catalog: CatalogView | null = null;
  let catalogError: string | null = null;
  try {
    catalog = toCatalogView(reloadConfig("models"));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    catalogError = firstConfigProblem(error);
  }
  let disclosure: AiDisclosureRow[] | null = null;
  try {
    const ai = reloadConfig("ai");
    disclosure = aiDisclosure(ai);
  } catch {
    // an unreadable ai.yaml is reported by its tab
  }
  let telegramEnabled: boolean | null = null;
  try {
    telegramEnabled = reloadConfig("notify").telegram.enabled;
  } catch {
    // an unreadable notify.yaml is reported by its tab
  }
  let db: ReturnType<typeof getDb> | null = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }
  const telegram = await loadTelegramStatus({ enabled: telegramEnabled, db });
  return { sections, status, channelChoices, providerStates, catalog, catalogError, workflow: await loadWorkflowView(), criteriaImpact: await loadCriteriaImpact(), aiDisclosure: disclosure, telegram };
}
