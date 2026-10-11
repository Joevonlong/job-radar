/** Reads everything /sources/ai-usage shows (server only): config, SQL aggregates, view model. */
import { API_PROVIDER_IDS } from "@/lib/ai/usage";
import { loadModelCatalog } from "@/lib/ai/catalog";
import { AI_PROVIDER_KIND, type AiProviderId } from "@/lib/ai/types";
import { findCatalogModel, reloadConfig, type ModelsConfig } from "@/lib/config";
import { getAiUsageGroups, getDb, getDbNow, listAiUsageCalls, type AiUsageCall, type AiUsageFilter } from "@/lib/db";
import { dayInZone } from "@/lib/insights/range";

import { aiUsageHref, loadAiUsageSearchParams, pageOf, type AiUsageUrlState } from "./params";
import { resolveAiUsageRange, type ResolvedRange } from "./range";
import { buildAiUsageView, type AiUsageView } from "./view";

export interface AiUsagePageData {
  state: AiUsageUrlState;
  view: AiUsageView;
  timeZone: string;
  today: string;
  calls: AiUsageCall[];
  totalCalls: number;
  page: number;
  pageSize: number;
  csvMaxRows: number;
  /** `/sources/ai-usage/export?...` for the current range and filters */
  exportHref: string;
  /** model id -> display name per provider is resolved here; the components only get strings */
  modelLabels: Record<string, string>;
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

interface Resolved {
  state: AiUsageUrlState;
  range: ResolvedRange;
  filter: AiUsageFilter;
  timeZone: string;
  today: string;
  settings: ReturnType<typeof reloadConfig<"ui">>["ai_usage"];
  catalog: ModelsConfig | null;
}

async function resolve(searchParams: SearchParams, at?: Date): Promise<Resolved> {
  const state = await loadAiUsageSearchParams(searchParams);
  // the web process has no config watcher and these files are meant to be edited while the page is open
  const settings = reloadConfig("ui").ai_usage;
  const timeZone = reloadConfig("schedule").timezone;
  const now = at ?? (await getDbNow(getDb()));
  const today = dayInZone(now, timeZone);
  const range = resolveAiUsageRange(state, { today, defaultRange: settings.default_range, customMaxDays: settings.custom_max_days });
  const filter: AiUsageFilter = {
    from: range.from,
    to: range.to,
    timeZone,
    ...(state.provider !== null ? { provider: state.provider } : {}),
    ...(state.model !== null ? { model: state.model } : {}),
    ...(state.task !== null ? { task: state.task } : {}),
  };
  return { state, range, filter, timeZone, today, settings, catalog: loadModelCatalog() };
}

export async function loadAiUsagePage(searchParams: SearchParams, at?: Date): Promise<AiUsagePageData> {
  const { state, range, filter, timeZone, today, settings, catalog } = await resolve(searchParams, at);
  const db = getDb();
  const groups = await getAiUsageGroups(db, filter, API_PROVIDER_IDS);
  const view = buildAiUsageView({
    groups,
    range,
    filter: { provider: filter.provider, model: filter.model, task: filter.task },
    labels: (provider, model) => (catalog ? (findCatalogModel(catalog, provider as AiProviderId, model)?.model.label ?? null) : null),
    isSubscription: (provider) => AI_PROVIDER_KIND[provider as AiProviderId] === "cli",
  });
  const totalCalls = view.totals.calls;
  const lastPage = Math.max(1, Math.ceil(totalCalls / settings.log_page_size));
  const page = Math.min(pageOf(state), lastPage);
  const calls = view.empty ? [] : await listAiUsageCalls(db, filter, { limit: settings.log_page_size, offset: (page - 1) * settings.log_page_size });
  const modelLabels: Record<string, string> = {};
  for (const row of view.byModel) if (row.provider && row.model && row.modelLabel) modelLabels[`${row.provider}|${row.model}`] = row.modelLabel;
  if (catalog) {
    for (const call of calls) {
      if (call.model === null) continue;
      const label = findCatalogModel(catalog, call.provider as AiProviderId, call.model)?.model.label;
      if (label) modelLabels[`${call.provider}|${call.model}`] = label;
    }
  }
  const exportHref = aiUsageHref({ ...state, metric: null, page: null }, {}, "/sources/ai-usage/export");
  return { state: { ...state, page }, view, timeZone, today, calls, totalCalls, page, pageSize: settings.log_page_size, csvMaxRows: settings.csv_max_rows, exportHref, modelLabels };
}

/** The export route: the newest `csv_max_rows` calls of the current range and filters. */
export async function loadAiUsageCsvRows(searchParams: SearchParams): Promise<{ from: string; to: string; timeZone: string; rows: AiUsageCall[] }> {
  const { range, filter, timeZone, settings } = await resolve(searchParams);
  const rows = await listAiUsageCalls(getDb(), filter, { limit: settings.csv_max_rows, offset: 0 });
  return { from: range.from, to: range.to, timeZone, rows };
}
