/**
 * Setup step 2: the market. Writes preferences.yaml `market`, `home_city`, `places` (through `savePreferencesPatch`, so the
 * profile history gets a snapshot) and schedule.yaml `timezone`. Everything is
 * validated before the first write, so a bad time zone never leaves half a market behind. Switching the pack's local
 * channels on is the sources step's job (it pre-selects the pack's `default_channels`).
 */
import { isValidTimeZone, loadConfig, mutateConfig, preferencesSchema, scheduleSchema, type PreferencesConfig } from "@/lib/config";
import { effectivePipeline, marketSettingsProblems, resolveMarket, type MarketSettings } from "@/lib/market";
import { placeGeo, samePlaceKey, storedPlaceName } from "@/lib/market/places";
import { preferencesConfigToDraft, preferencesDraftToCandidate, toFieldErrors, type FieldError, type PreferencesDraft } from "@/lib/profile/draft";
import { savePreferencesPatch } from "@/lib/profile/service";

import { marketInputSchema } from "../inputs";
import { stepError, type SetupFieldError, type SetupStepResult } from "../types";
import { editable, profileFieldErrors, profileSaveProblem, readFresh, setupWriteError, withStepWrite } from "./common";

type PlaceEntry = PreferencesConfig["places"][number];

/** The fields of the market step (the other preferences fields are reported by the targets step). */
const MARKET_PATHS = /^(market(\.|$)|home_city$|places$)/;

function marketProblems(draftMarket: unknown): FieldError[] {
  const parsed = preferencesSchema.shape.market.safeParse(draftMarket);
  if (!parsed.success) return [];
  return marketSettingsProblems(parsed.data).map((p): FieldError => ({
    path: `market.${p.field}`,
    ...(p.problem === "missing" ? { key: "required" as const } : p.problem === "unknown" ? { key: "invalidChoice" as const } : { key: "invalid" as const, params: { message: p.detail ?? "" } }),
  }));
}

/** The places as the form writes them, in the chosen market's tables: each once, a ✈ on any spelling winning, without the home city. What comes from the command line can spell them any way. */
function storedPlaces(places: readonly PlaceEntry[], market: MarketSettings, homeCity: string): PlaceEntry[] {
  const geo = placeGeo(effectivePipeline(loadConfig("pipeline"), resolveMarket(market)));
  const home = samePlaceKey(homeCity, geo);
  const byKey = new Map<string, PlaceEntry>();
  for (const { place, relocate } of places) {
    const key = samePlaceKey(place, geo);
    if (key !== home) byKey.set(key, { place: storedPlaceName(place, geo), relocate: relocate || (byKey.get(key)?.relocate ?? false) });
  }
  return [...byKey.values()];
}

export async function saveMarketStep(raw: unknown): Promise<SetupStepResult> {
  const parsed = marketInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("market", "invalidPayload");
  const input = parsed.data;

  const preferences = readFresh("preferences");
  if (preferences === null) return stepError("market", "profileUnreadable");
  const schedule = readFresh("schedule");
  if (schedule === null) return stepError("market", "configUnreadable");

  const errors: SetupFieldError[] = [];
  const draft: PreferencesDraft = { ...preferencesConfigToDraft(preferences), market: input.market, home_city: input.home_city, places: input.places };
  const candidate = preferencesSchema.safeParse(preferencesDraftToCandidate(draft));
  if (!candidate.success) {
    errors.push(...profileFieldErrors(toFieldErrors(candidate.error).filter((e) => MARKET_PATHS.test(e.path))));
  } else {
    errors.push(...profileFieldErrors(marketProblems(candidate.data.market)));
  }

  if (!isValidTimeZone(input.timezone.trim())) errors.push({ path: "timezone", ns: "setup", key: "timezone" });
  const nextSchedule = scheduleSchema.safeParse({ ...editable(schedule), timezone: input.timezone.trim() });
  if (!nextSchedule.success && !errors.some((e) => e.path === "timezone")) errors.push({ path: "timezone", ns: "setup", key: "timezone" });

  if (!candidate.success || errors.length > 0 || !nextSchedule.success) return stepError("market", null, errors);

  return withStepWrite("market", async () => {
    const saved = await savePreferencesPatch({ market: input.market, home_city: input.home_city, places: storedPlaces(candidate.data.places, candidate.data.market, candidate.data.home_city) });
    const problem = profileSaveProblem("market", saved);
    if (problem !== null) return problem;
    try {
      await mutateConfig("schedule", (current) => ({ ...current, timezone: nextSchedule.data.timezone }));
    } catch (error) {
      return stepError("market", setupWriteError(error));
    }
    return null;
  });
}
