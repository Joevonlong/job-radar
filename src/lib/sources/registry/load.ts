/** Reads what `/sources/registry` and `pnpm sources:list` show (server only): the file, the health reads, the mirror state. */
import fs from "node:fs";

import {
  ConfigError,
  configSourcePath,
  displayConfigPath,
  hashConfigText,
  readConfigText,
  reloadConfig,
  type ChannelsConfig,
  type ConfigIssue,
} from "@/lib/config";
import { ATS_KINDS, REGISTRY_DEFAULTS } from "@/lib/config";
import { getBoardSeenCounts, getChannelWindowStats, getDb, getDbNow, listBoardHealth, listSourceRegistryRows, type Db } from "@/lib/db";

import { loadSourcesView } from "../load";
import { buildRegistryView, buildRegistryViewFromMirror, type RegistryView } from "./view";
import { readRegistrySyncState, syncSourceRegistry } from "./sync";

export interface RegistryFileState {
  mode: "current" | "missing";
  /** The file the registry is read from, for people (`data/config/sources.yaml`). */
  label: string;
  /** Reasons the file cannot be read (path + reason, at most 5); null when it is fine. */
  invalid: ConfigIssue[] | null;
}

export interface RegistryMirrorState {
  /** When the mirror was last synced (ISO); null = never. */
  syncedAt: string | null;
  /** The mirror matches the file as it is now. */
  inSync: boolean;
}

export interface RegistryPageData {
  view: RegistryView;
  file: RegistryFileState;
  mirror: RegistryMirrorState;
  limits: { importMaxBytes: number; candidatesPageSize: number };
  /** Where a budget battery draws its red line, percent (`notify.yaml: alerts.budget_thresholds`). */
  alertPercent: number;
  /** A cycle is running now: the page refreshes itself. */
  cycleRunning: boolean;
}

const MAX_BANNER_ISSUES = 5;

function describeInvalid(error: ConfigError): ConfigIssue[] {
  if (error.issues.length > 0) return error.issues.slice(0, MAX_BANNER_ISSUES);
  return [{ path: "", message: error.message.split("\n")[0]?.replace(/^Config "[^"]*"[^:(]*\([^)]*\):?\s*/, "") || "unreadable" }];
}

/** Sync the mirror when the file's hash differs from the last recorded sync. Returns whether the mirror matches the file afterwards. */
async function ensureMirror(db: Db, config: ChannelsConfig, text: string, sync: boolean): Promise<{ inSync: boolean; syncedAt: string | null }> {
  const hash = hashConfigText(text);
  try {
    const state = await readRegistrySyncState(db);
    if (state?.hash === hash) return { inSync: true, syncedAt: state.at };
    if (!sync) return { inSync: false, syncedAt: state?.at ?? null };
    await syncSourceRegistry(db, { config, text });
    return { inSync: true, syncedAt: new Date().toISOString() };
  } catch {
    return { inSync: false, syncedAt: (await readRegistrySyncState(db).catch(() => null))?.at ?? null };
  }
}

/** Everything the registry page needs. The file is re-read on every call (the web process has no watcher). */
export async function loadRegistryPage(options: { syncMirror?: boolean } = {}): Promise<RegistryPageData> {
  const db = getDb();
  const now = await getDbNow(db);
  const mode = fs.existsSync(/*turbopackIgnore: true*/ configSourcePath("channels")) ? "current" : "missing";
  let config: ChannelsConfig | null = null;
  let invalid: ConfigIssue[] | null = null;
  let text = "";
  try {
    text = readConfigText("channels");
    config = reloadConfig("channels");
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    invalid = describeInvalid(error);
  }
  const label = displayConfigPath(configSourcePath("channels"));
  const file: RegistryFileState = { mode, label, invalid };

  if (config === null) {
    // the file cannot be read: show the mirror (the last good sync) with the live health
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const [rows, channelStats, boardHealth, boardSeen, sync] = await Promise.all([
      listSourceRegistryRows(db),
      getChannelWindowStats(db, { since }),
      listBoardHealth(db),
      getBoardSeenCounts(db, { since, atsIds: ATS_KINDS }),
      readRegistrySyncState(db).catch(() => null),
    ]);
    return {
      view: buildRegistryViewFromMirror({ now, rows, channelStats, boardHealth, boardSeen, settings: REGISTRY_DEFAULTS }),
      file,
      mirror: { syncedAt: sync?.at ?? null, inSync: false },
      limits: { importMaxBytes: 524288, candidatesPageSize: 10 },
      alertPercent: 100,
      cycleRunning: false,
    };
  }

  const since = new Date(now.getTime() - config.registry.window_days * 86_400_000);
  const [sources, channelStats, boardHealth, boardSeen, mirror] = await Promise.all([
    loadSourcesView(now),
    getChannelWindowStats(db, { since }),
    listBoardHealth(db),
    getBoardSeenCounts(db, { since, atsIds: ATS_KINDS }),
    ensureMirror(db, config, text, options.syncMirror ?? true),
  ]);
  return {
    view: buildRegistryView({ now, config, cards: sources.cards, channelStats, boardHealth, boardSeen }),
    file,
    mirror,
    limits: { importMaxBytes: config.registry.import_max_bytes, candidatesPageSize: config.registry.candidates_page_size ?? 10 },
    alertPercent: sources.budgetAlertPercent,
    cycleRunning: sources.latestCycle?.status === "running",
  };
}
