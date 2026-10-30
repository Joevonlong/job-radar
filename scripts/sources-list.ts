/**
 * Print the source registry: every collection source of config/sources.yaml with its state and the reason.
 *
 *   pnpm sources:list [--type channel|ats_board] [--status failing ...] [--all] [--json] [--sync] [--strict]
 *
 * --all     also list entries that left the file (from the database mirror)
 * --json    machine-readable output
 * --sync    first mirror the file into the database
 * --strict  exit 1 when an enabled source is failing
 * --lang    en | zh …: the language of the table (default: language.yaml cli.locale, else the interface default)
 * Without a database only the file's entries are listed (health unknown).
 */
import { parseArgs } from "node:util";

import { ConfigError, configSourcePath, displayConfigPath, loadConfig, readConfigText, reloadConfig, type ChannelsConfig } from "../src/lib/config";
import { closeDb, getDb, listSourceRegistryRows } from "../src/lib/db";
import { buildRegistryEntries } from "../src/lib/sources/registry/entries";
import { scopeLocale } from "../src/lib/i18n/node";
import { cliRows, hasFailingEnabled, registryText, removedRows, renderRegistryJson, renderRegistryText, sortCliRows, unknownRows, type CliRow } from "../src/lib/sources/registry/cli";
import { loadRegistryPage } from "../src/lib/sources/registry/load";
import { isRegistryStatus, REGISTRY_STATUSES, type RegistryStatus } from "../src/lib/sources/registry/status";
import { syncSourceRegistry } from "../src/lib/sources/registry/sync";
import { buildCompanyQueries } from "../src/lib/channels/query";
import type { SearchQuery } from "../src/lib/channels/types";
import { CHANNEL_CONFIG_TABLE, channelSupportsCompanyQueries, isConfiguredChannelId, settingsFromConfig } from "../src/lib/channels/registry";
import { watchedCompanyBoards } from "../src/lib/companies/watched-boards";
import { currentWatchedCompanies } from "../src/lib/filter";
import { loadPipeline } from "../src/lib/market";
import { translatorFor } from "../src/lib/i18n/node";

function usage(message: string): never {
  console.error(`sources:list: ${message}`);
  console.error("usage: pnpm sources:list [--type channel|ats_board] [--status <status> ...] [--all] [--json] [--sync] [--strict] [--lang <locale>]");
  console.error(`statuses: ${REGISTRY_STATUSES.join(", ")}`);
  process.exit(2);
}

const args = (() => {
  try {
    return parseArgs({
      options: { type: { type: "string" }, status: { type: "string", multiple: true }, all: { type: "boolean" }, json: { type: "boolean" }, sync: { type: "boolean" }, strict: { type: "boolean" }, lang: { type: "string" } },
      strict: true,
    }).values;
  } catch (error) {
    return usage(error instanceof Error ? error.message : "invalid arguments");
  }
})();

const type = args.type === undefined ? null : args.type === "channel" || args.type === "ats_board" ? args.type : usage(`--type must be channel or ats_board, got "${args.type}"`);
const statuses: RegistryStatus[] = (args.status ?? []).map((s) => (isRegistryStatus(s) ? s : usage(`unknown status "${s}"`)));

async function main(): Promise<number> {
  let config: ChannelsConfig;
  let text: string;
  try {
    text = readConfigText("channels");
    config = reloadConfig("channels");
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`sources:list: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const timeZone = loadConfig("schedule").timezone;
  const words = registryText(scopeLocale("cli", args.lang));
  const fileLabel = displayConfigPath(configSourcePath("channels"));
  const entries = buildRegistryEntries(config);

  let rows: CliRow[];
  let counts: Record<RegistryStatus, number> | null = null;
  let mirror: { syncedAt: string | null; inSync: boolean } | null = null;
  let windowDays = config.registry.window_days;
  let dbOk = true;
  try {
    const db = getDb();
    if (args.sync) await syncSourceRegistry(db, { config, text });
    const page = await loadRegistryPage({ syncMirror: false });
    counts = page.view.counts;
    mirror = page.mirror;
    windowDays = page.view.windowDays;
    rows = cliRows(page.view, { type, statuses }, timeZone, words);
    if (args.all) {
      const gone = (await listSourceRegistryRows(db, { includeRemoved: true })).filter((r) => !r.inConfig);
      rows.push(...removedRows(gone.map((r) => ({ id: r.id, type: r.type === "ats_board" ? ("ats_board" as const) : ("channel" as const), name: r.name, removedAt: r.removedAt?.toISOString() ?? null })), timeZone, words));
    }
  } catch {
    dbOk = false;
    rows = unknownRows(entries.filter((e) => type === null || e.type === type), words).filter(() => statuses.length === 0);
    if (statuses.length > 0) console.error("sources:list: the database is not reachable, --status cannot be applied");
  }

  const sorted = sortCliRows(rows);
  const enabledCompanyChannels = Object.keys(CHANNEL_CONFIG_TABLE).filter(isConfiguredChannelId).filter((id) => channelSupportsCompanyQueries(id) && settingsFromConfig(id, config).enabled && settingsFromConfig(id, config).companyQueries);
  let companyQueries: Pick<SearchQuery, "id" | "company">[] = [];
  try {
    const search = loadConfig("search");
    const watched = search.watched_company_queries.enabled ? currentWatchedCompanies() : [];
    if (enabledCompanyChannels.length > 0 && watched.length > 0) {
      companyQueries = buildCompanyQueries(search, watchedCompanyBoards(watched, config.ats_boards, loadPipeline()), 0).map((q) => ({ id: q.id, company: q.company }));
    }
  } catch { /* Optional query labels must not make the source registry unavailable. */ }
  const companyText = translatorFor(scopeLocale("cli", args.lang), "cli.companyQueries");
  const report = { rows: sorted, windowDays, timeZone, fileLabel, total: entries.length, counts, mirror };
  if (args.json) {
    const rendered: unknown = JSON.parse(renderRegistryJson({ ...report, generatedAt: new Date().toISOString() }));
    console.log(JSON.stringify({ ...(rendered as Record<string, unknown>), companyQueries }, null, 2));
  } else {
    console.log(renderRegistryText(report, words));
    if (companyQueries.length > 0) console.log(`\n${companyText("title")}\n${companyQueries.map((q) => `  ${companyText("company", { name: q.company!.name })} (${q.id})`).join("\n")}`);
  }
  await closeDb().catch(() => {});
  if (args.strict && (!dbOk || hasFailingEnabled(sorted))) return 1;
  return 0;
}

process.exit(await main().catch((error: unknown) => {
  console.error(`sources:list: ${error instanceof Error ? error.message : String(error)}`);
  return 2;
}));
