/**
 * Setup step 2: the market. Writes preferences.yaml `market`, `locations`, `remote_scope` (through `savePreferencesPatch`, so the
 * profile history gets a snapshot), search.yaml `locations` / `remote_scope` and schedule.yaml `timezone`. Everything is
 * validated before the first write, so a bad time zone never leaves half a market behind. Switching the pack's local
 * channels on is the sources step's job (it pre-selects the pack's `default_channels`).
 */
import { ensureProfileFiles, isValidTimeZone, mutateConfig, preferencesSchema, scheduleSchema, searchSchema } from "@/lib/config";
import { marketSettingsProblems } from "@/lib/market";
import { parseRemoteScopeKey } from "@/lib/market/remote-scope";
import { preferencesConfigToDraft, preferencesDraftToCandidate, toFieldErrors, type FieldError, type PreferencesDraft } from "@/lib/profile/draft";
import { savePreferencesPatch } from "@/lib/profile/service";

import { cleanTitles } from "../keywords";
import { marketInputSchema } from "../inputs";
import { stepError, type SetupFieldError, type SetupStepResult } from "../types";
import { editable, finishStep, profileFieldErrors, profileSaveProblem, readFresh, zodSetupErrors, setupFrozen, setupWriteError } from "./common";

/** The fields of the market step (the other preferences fields are reported by the targets step). */
const MARKET_PATHS = /^(market(\.|$)|locations$|remote_scope$)/;

function marketProblems(draftMarket: unknown): FieldError[] {
  const parsed = preferencesSchema.shape.market.safeParse(draftMarket);
  if (!parsed.success) return [];
  return marketSettingsProblems(parsed.data).map((p): FieldError => ({
    path: `market.${p.field}`,
    ...(p.problem === "missing" ? { key: "required" as const } : p.problem === "unknown" ? { key: "invalidChoice" as const } : { key: "invalid" as const, params: { message: p.detail ?? "" } }),
  }));
}

export async function saveMarketStep(raw: unknown): Promise<SetupStepResult> {
  const frozen = setupFrozen("market");
  if (frozen) return frozen;
  const parsed = marketInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("market", "invalidPayload");
  const input = parsed.data;
  const locations = cleanTitles(input.locations);

  try {
    await ensureProfileFiles();
  } catch {
    // the profile directory is not writable: reading below reports it
  }
  const preferences = readFresh("preferences");
  if (preferences === null) return stepError("market", "profileUnreadable");
  const search = readFresh("search");
  const schedule = readFresh("schedule");
  if (search === null || schedule === null) return stepError("market", "configUnreadable");

  const errors: SetupFieldError[] = [];
  const draft: PreferencesDraft = { ...preferencesConfigToDraft(preferences), market: input.market, locations, remote_scope: input.remote_scope };
  const candidate = preferencesSchema.safeParse(preferencesDraftToCandidate(draft));
  if (!candidate.success) {
    errors.push(...profileFieldErrors(toFieldErrors(candidate.error).filter((e) => MARKET_PATHS.test(e.path))));
  } else {
    errors.push(...profileFieldErrors(marketProblems(candidate.data.market)));
  }

  const scope = parseRemoteScopeKey(input.remote_scope);
  const nextSearch = searchSchema.safeParse({ ...editable(search), locations, remote_scope: scope ?? input.remote_scope });
  if (!nextSearch.success) {
    const own = zodSetupErrors(nextSearch.error, (path) => String(path[0] ?? ""));
    errors.push(...own.filter((e) => !errors.some((x) => x.path === e.path)));
  }

  if (!isValidTimeZone(input.timezone.trim())) errors.push({ path: "timezone", ns: "setup", key: "timezone" });
  const nextSchedule = scheduleSchema.safeParse({ ...editable(schedule), timezone: input.timezone.trim() });
  if (!nextSchedule.success && !errors.some((e) => e.path === "timezone")) errors.push({ path: "timezone", ns: "setup", key: "timezone" });

  if (errors.length > 0 || !nextSearch.success || !nextSchedule.success) return stepError("market", null, errors);

  const saved = await savePreferencesPatch({ market: input.market, locations, remote_scope: input.remote_scope });
  const problem = profileSaveProblem("market", saved);
  if (problem !== null) return problem;
  try {
    await mutateConfig("search", (current) => ({ ...current, locations, remote_scope: nextSearch.data.remote_scope }));
    await mutateConfig("schedule", (current) => ({ ...current, timezone: nextSchedule.data.timezone }));
  } catch (error) {
    return stepError("market", setupWriteError(error));
  }
  return finishStep("market");
}
