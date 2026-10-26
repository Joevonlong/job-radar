/**
 * Everything the /setup page shows, read fresh on every request (server only). Serializable for the client.
 * Environment variables appear as names with present / absent only; no value is read into this view (C4).
 */
import { consentKind, type ConsentKind } from "@/lib/channels/access";
import { CHANNEL_GROUP } from "@/lib/sources/registry/entries";
import { AI_PROVIDER_CONFIG_KEYS, AI_PROVIDER_IDS, AI_PROVIDER_KIND, type AiProviderIdChoice, type AiProviderKindChoice } from "@/lib/config/ai-options";
import { ATS_KINDS, type AiConfig, type ChannelsConfig } from "@/lib/config";
import { getDb, getDbNow, getLatestHeartbeat } from "@/lib/db";
import type { Locale } from "@/i18n/locale";
import { GENERIC_PACK_ID, listPackIds, loadMarket, loadPack } from "@/lib/market";
import { remoteScopeKey } from "@/lib/market/remote-scope";
import { loadAiWorkerStatus } from "@/lib/ops/ai-worker";
import { loadTelegramStatus, type TelegramStatusView } from "@/lib/notify/telegram-status";
import type { Db } from "@/lib/db/client";
import { meConfigToDraft, preferencesConfigToDraft, type MarketDraft, type MeDraft } from "@/lib/profile/draft";
import { readProfileReadiness } from "@/lib/scoring/profile";
import { toCatalogView, type CatalogView } from "@/lib/settings/catalog-view";
import { heartbeatView } from "@/lib/settings/status";
import { vendorOf, type AiVendorId } from "@/lib/settings/ai-vendors";
import { isConfiguredChannelId, settingsFromConfig } from "@/lib/channels/registry";

import { aiKeyEnv, channelEnv } from "./env";
import type { MarketInput, TargetsInput } from "./inputs";
import { buildReadiness, type ReadinessItem } from "./readiness";
import { readSetupState } from "./state";
import { SETUP_STEP_IDS, type SetupStepId, type SetupStepStatus } from "./steps";
import { readFresh } from "./steps/common";
import { readLanguageDefaults } from "./steps/language";
import { channelSwitch, offeredChannelIds } from "./steps/sources";
import { STRONG_MODEL_PROVIDERS } from "./steps/ai";
import { shippedKeywordGroups } from "./steps/targets";
import type { EnvPresence } from "./types";
import type { RegistryGroup } from "@/lib/sources/registry/groups";

export interface StepState {
  status: SetupStepStatus | null;
  at: string | null;
}

export interface ChannelChoice {
  id: string;
  group: RegistryGroup;
  /** The switch in sources.yaml now. */
  enabled: boolean;
  /** One of the market pack's own channels (pre-selected before the step was saved once, unless it needs `consent`). */
  local: boolean;
  /** Switching it on needs the user's terms-of-service acknowledgement of this kind (`channels/access.ts`); never pre-selected. */
  consent: ConsentKind | null;
  env: EnvPresence[];
}

export interface AiProviderChoice {
  id: AiProviderIdChoice;
  vendor: AiVendorId;
  access: "cli" | "api";
  enabled: boolean;
  /** ai.yaml model ("" = codex-cli's own default). */
  model: string;
  /** ai.yaml strong model; null for providers without one. */
  strongModel: string | null;
  /** The API key's variable (name, present / absent); null for the subscription CLIs. */
  key: EnvPresence | null;
}

export interface SetupView {
  pending: boolean;
  /** The install is from before the wizard existed: steps nobody recorded are not "open", just untracked. */
  existingInstall: boolean;
  /** setup.yaml cannot be read (the doctor names it): the wizard still works, it just cannot record progress. */
  stateError: string | null;
  steps: Record<SetupStepId, StepState>;
  language: {
    current: Locale;
    /** From the browser's Accept-Language, offered before the step was saved once. */
    suggested: Locale | null;
    /** language.yaml can be read (else only the cookie is set). */
    fileAvailable: boolean;
    aiOutput: string;
    translationTarget: string;
  };
  market: {
    /** null when preferences.yaml or search / schedule cannot be read. */
    draft: MarketInput | null;
    saved: MarketDraft | null;
    /** Pack's city names per country (candidates; free text is fine too). */
    cities: Record<string, string[]>;
    /** Per country what the packs propose when it is picked: its currency and its main city (null: none known). */
    countryDefaults: Record<string, CountryDefaults>;
  };
  profile: { draft: MeDraft | null; localLanguage: string | null };
  targets: {
    draft: TargetsInput | null;
    keywordGroups: Record<string, string[]> | null;
    shippedKeywordGroups: Record<string, string[]> | null;
  };
  sources: { channels: ChannelChoice[]; boards: Array<{ name: string; ats: string; token: string; enabled: boolean }>; atsKinds: string[]; problem: "unreadable" | null };
  ai: {
    providers: AiProviderChoice[];
    order: AiProviderKindChoice[];
    execution: AiConfig["execution"] | null;
    catalog: CatalogView | null;
    worker: { online: boolean; ageSeconds: number | null } | null;
  };
  /** `status` says whether the variables are set (names and booleans only) and the last test; `.env` is written by `pnpm run setup --step telegram` on the host. */
  telegram: { enabled: boolean | null; status: TelegramStatusView; fileAvailable: boolean; notifyLocale: Locale | null };
  review: { readiness: ReadinessItem[] };
}

function stepStates(steps: Partial<Record<SetupStepId, { status: SetupStepStatus; at: string }>>): Record<SetupStepId, StepState> {
  return Object.fromEntries(SETUP_STEP_IDS.map((id) => [id, { status: steps[id]?.status ?? null, at: steps[id]?.at ?? null }])) as Record<SetupStepId, StepState>;
}

/** City names of every pack, by country: the canonical names of the city table and the metro areas of a country's pack. */
export function cityCandidates(): Record<string, string[]> {
  const byCountry = new Map<string, Set<string>>();
  const add = (country: string, city: string): void => {
    const set = byCountry.get(country) ?? new Set<string>();
    set.add(city);
    byCountry.set(country, set);
  };
  for (const id of listPackIds()) {
    try {
      const pack = loadPack(id);
      for (const [city, country] of Object.values(pack.geography.cities)) add(country, city);
      const country = pack.meta.country;
      if (country !== undefined) for (const city of Object.keys(pack.geography.metro_areas)) add(country, city);
    } catch {
      // an invalid pack is reported by config:check and the doctor
    }
  }
  return Object.fromEntries([...byCountry].map(([country, set]) => [country, [...set].sort((a, b) => a.localeCompare(b))]));
}

export interface CountryDefaults {
  currency: string | null;
  city: string | null;
}

/**
 * What the market step proposes for a picked country, from the packs: the currency of the country's own pack, else the
 * country table's `currency`; the first city of the city tables (the generic pack's table lists a country's main city
 * first), else the first metro area of the country's own pack.
 */
export function countryDefaults(): Record<string, CountryDefaults> {
  const out = new Map<string, CountryDefaults>();
  const entry = (country: string): CountryDefaults => {
    const found = out.get(country) ?? { currency: null, city: null };
    out.set(country, found);
    return found;
  };
  const ids = listPackIds().sort((a, b) => (a === GENERIC_PACK_ID ? -1 : b === GENERIC_PACK_ID ? 1 : a.localeCompare(b)));
  const packs = ids.flatMap((id) => {
    try {
      return [loadPack(id)];
    } catch {
      return []; // an invalid pack is reported by config:check and the doctor
    }
  });
  for (const pack of packs) {
    const { country, currency } = pack.meta;
    if (country !== undefined && currency !== undefined) entry(country).currency = currency;
  }
  for (const pack of packs) {
    for (const c of pack.geography.countries) if (c.currency !== undefined) entry(c.code).currency ??= c.currency;
    for (const [city, country] of Object.values(pack.geography.cities)) entry(country).city ??= city;
  }
  for (const pack of packs) {
    const country = pack.meta.country;
    const metro = Object.keys(pack.geography.metro_areas)[0];
    if (country !== undefined && metro !== undefined) entry(country).city ??= metro;
  }
  return Object.fromEntries(out);
}

/**
 * The profile step's draft. Before the step was ever saved, a city that is none of the market step's cities (the example
 * profile's, from another country) is replaced by the first of them; `locations` is null once the step was saved.
 */
export function profileDraft(draft: MeDraft, locations: readonly string[] | null): MeDraft {
  if (locations === null || locations.length === 0) return draft;
  const city = draft.city.trim().toLowerCase();
  if (locations.some((l) => l.trim().toLowerCase() === city)) return draft;
  return { ...draft, city: locations[0] ?? draft.city };
}

function marketPart(): SetupView["market"] {
  const preferences = readFresh("preferences");
  const search = readFresh("search");
  const schedule = readFresh("schedule");
  const cities = cityCandidates();
  const defaults = countryDefaults();
  if (preferences === null || search === null || schedule === null) return { draft: null, saved: preferences === null ? null : preferencesConfigToDraft(preferences).market, cities, countryDefaults: defaults };
  const prefs = preferencesConfigToDraft(preferences);
  return { draft: { market: prefs.market, locations: [...prefs.locations], remote_scope: remoteScopeKey(preferences.remote_scope), timezone: schedule.timezone }, saved: prefs.market, cities, countryDefaults: defaults };
}

function targetsPart(): SetupView["targets"] {
  const preferences = readFresh("preferences");
  const search = readFresh("search");
  const shipped = shippedKeywordGroups();
  const copy = (groups: Readonly<Record<string, readonly string[]>> | null): Record<string, string[]> | null => (groups === null ? null : Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]])));
  if (preferences === null) return { draft: null, keywordGroups: copy(search?.keyword_groups ?? null), shippedKeywordGroups: copy(shipped) };
  const d = preferencesConfigToDraft(preferences);
  return {
    draft: {
      target_titles: d.target_titles,
      seniority: d.seniority,
      workplace: d.workplace,
      salary_floor_year: d.salary_floor_year,
      contracts: d.contracts,
      exclude_student_roles: d.exclude_student_roles,
      exclude_companies: d.exclude_companies,
      exclude_keywords: d.exclude_keywords,
    },
    keywordGroups: copy(search?.keyword_groups ?? null),
    shippedKeywordGroups: copy(shipped),
  };
}

function localChannelIds(): readonly string[] {
  try {
    return loadMarket().defaultChannels;
  } catch {
    return [];
  }
}

function sourcesPart(config: ChannelsConfig | null): SetupView["sources"] {
  if (config === null) return { channels: [], boards: [], atsKinds: [...ATS_KINDS], problem: "unreadable" };
  const local = new Set(localChannelIds());
  const channels = offeredChannelIds(config).map((id): ChannelChoice => ({ id, group: CHANNEL_GROUP[id], enabled: channelSwitch(config, id), local: local.has(id), consent: consentKind(id), env: channelEnv(id) }));
  const boards = config.ats_boards.map((b) => ({ name: b.name, ats: b.ats, token: b.token, enabled: b.enabled }));
  return { channels, boards, atsKinds: [...ATS_KINDS], problem: null };
}

function aiProviders(ai: AiConfig): AiProviderChoice[] {
  return AI_PROVIDER_IDS.map((id): AiProviderChoice => {
    const block = ai.providers[AI_PROVIDER_CONFIG_KEYS[id]] as { enabled: boolean; model?: string; strong_model?: string };
    return {
      id,
      vendor: vendorOf(id),
      access: AI_PROVIDER_KIND[id],
      enabled: block.enabled,
      model: block.model ?? "",
      strongModel: STRONG_MODEL_PROVIDERS.includes(id) ? (block.strong_model ?? "") : null,
      key: aiKeyEnv(id),
    };
  });
}

export interface Heartbeats {
  runnerOnline: boolean | null;
  worker: { online: boolean; ageSeconds: number | null } | null;
}

/** Runner and ai-worker heartbeats; nulls when the database cannot be read. */
/** The database handle, or null when it is not configured (the parts that need it are left out). */
function dbOrNull(): Db | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

export async function heartbeats(ai: AiConfig | null): Promise<Heartbeats> {
  try {
    const db = getDb();
    const now = await getDbNow(db);
    const runner = heartbeatView((await getLatestHeartbeat(db))?.at ?? null, now);
    if (ai === null) return { runnerOnline: runner.online, worker: null };
    const worker = await loadAiWorkerStatus(db, { now, aiConfig: ai });
    return { runnerOnline: runner.online, worker: { online: worker.online, ageSeconds: worker.ageSeconds } };
  } catch {
    return { runnerOnline: null, worker: null };
  }
}

/** The readiness list from the current files and heartbeats. */
export function readinessOf(input: { channels: ChannelsConfig | null; ai: AiConfig | null; heartbeats: Heartbeats; env?: Readonly<Record<string, string | undefined>> }): ReadinessItem[] {
  const env = input.env ?? process.env;
  const channels =
    input.channels === null
      ? null
      : (() => {
          const config = input.channels;
          // an ATS channel collects nothing without a company board, so it does not make the channels "ready" on its own
          const boardsOn = config.ats_boards.some((b) => b.enabled);
          const enabled = offeredChannelIds(config).filter((id) => isConfiguredChannelId(id) && settingsFromConfig(id, config).enabled && (CHANNEL_GROUP[id] !== "ats" || boardsOn));
          return { enabled, missingEnv: enabled.filter((id) => channelEnv(id, env).some((e) => !e.present)) };
        })();
  const ai =
    input.ai === null
      ? null
      : (() => {
          const enabled = aiProviders(input.ai).filter((p) => p.enabled && input.ai?.order.some((kind) => kind === p.id || (kind === "api" && p.access === "api")));
          return { enabled: enabled.map((p) => p.id), missingKey: enabled.filter((p) => p.key !== null && !(aiKeyEnv(p.id, env)?.present ?? false)).map((p) => p.id) };
        })();
  const profile = readProfileReadiness();
  return buildReadiness({
    profileMissing: profile === null ? null : profile.missing,
    channels,
    ai,
    runnerOnline: input.heartbeats.runnerOnline,
    aiWorker: input.ai?.execution === "container" ? "notNeeded" : input.heartbeats.worker === null ? null : input.heartbeats.worker.online ? "online" : "offline",
  });
}

export async function loadSetupView(options: { locale: Locale; acceptLanguage: Locale | null }): Promise<SetupView> {
  const status = readSetupState();
  const steps = stepStates(status.state?.steps ?? {});
  const channels = readFresh("channels");
  const ai = readFresh("ai");
  const models = readFresh("models");
  const notify = readFresh("notify");
  const me = readFresh("me");
  const beats = await heartbeats(ai);
  const languageDefaults = readLanguageDefaults();
  let localLanguage: string | null = null;
  try {
    localLanguage = loadMarket().homeLanguage;
  } catch {
    localLanguage = null;
  }
  const market = marketPart();
  return {
    pending: status.pending,
    existingInstall: status.source === "existing_install" || status.state?.completed_by === "existing_install",
    stateError: status.error,
    steps,
    language: {
      current: options.locale,
      suggested: steps.language.status === null ? options.acceptLanguage : null,
      fileAvailable: languageDefaults.aiOutput !== null,
      aiOutput: languageDefaults.aiOutput ?? options.locale,
      translationTarget: languageDefaults.translationTarget ?? options.locale,
    },
    market,
    profile: { draft: me === null ? null : profileDraft(meConfigToDraft(me), steps.profile.status === null ? (market.draft?.locations ?? null) : null), localLanguage },
    targets: targetsPart(),
    sources: sourcesPart(channels),
    ai: {
      providers: ai === null ? [] : aiProviders(ai),
      order: ai === null ? [] : [...ai.order],
      execution: ai?.execution ?? null,
      catalog: models === null ? null : toCatalogView(models),
      worker: beats.worker,
    },
    telegram: { enabled: notify?.telegram.enabled ?? null, status: await loadTelegramStatus({ enabled: notify?.telegram.enabled ?? null, db: dbOrNull() }), fileAvailable: languageDefaults.aiOutput !== null, notifyLocale: languageDefaults.notifyLocale },
    review: { readiness: readinessOf({ channels, ai, heartbeats: beats }) },
  };
}
