/**
 * Setup step 4: what I am looking for. Writes preferences.yaml (titles, level, work modes, salary floor, contracts,
 * exclusions) through `saveProfile`, and search.yaml `keyword_groups` by the rule of `keywords.ts`.
 */
import fs from "node:fs";

import { ensureProfileFiles, getDefaultConfigPath, parseConfigText, preferencesSchema, searchSchema, writeConfig } from "@/lib/config";
import { preferencesConfigToDraft, preferencesDraftToCandidate, toFieldErrors, type PreferencesDraft } from "@/lib/profile/draft";
import { saveProfile } from "@/lib/profile/service";

import { planKeywordGroups, type KeywordGroups } from "../keywords";
import { targetsInputSchema } from "../inputs";
import { stepError, type SetupFieldError, type SetupStepResult } from "../types";
import { editable, finishStep, profileFieldErrors, profileSaveProblem, readFresh, zodSetupErrors, setupFrozen, setupWriteError } from "./common";

/** The market step owns these preferences fields; their errors are not this step's. */
const NOT_MINE = /^(market(\.|$)|locations$|remote_scope$)/;

/** The shipped default `keyword_groups` (null when the defaults directory has no readable search.yaml). */
export function shippedKeywordGroups(): KeywordGroups | null {
  const file = getDefaultConfigPath("search");
  if (file === null) return null;
  try {
    return parseConfigText("search", fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"), file).keyword_groups;
  } catch {
    return null;
  }
}

export async function saveTargetsStep(raw: unknown): Promise<SetupStepResult> {
  const frozen = setupFrozen("targets");
  if (frozen) return frozen;
  const parsed = targetsInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("targets", "invalidPayload");
  try {
    await ensureProfileFiles();
  } catch {
    // reported by the read below
  }
  const preferences = readFresh("preferences");
  if (preferences === null) return stepError("targets", "profileUnreadable");
  const search = readFresh("search");
  if (search === null) return stepError("targets", "configUnreadable");

  const draft: PreferencesDraft = { ...preferencesConfigToDraft(preferences), ...parsed.data };
  const errors: SetupFieldError[] = [];
  const candidate = preferencesSchema.safeParse(preferencesDraftToCandidate(draft));
  if (!candidate.success) errors.push(...profileFieldErrors(toFieldErrors(candidate.error).filter((e) => !NOT_MINE.test(e.path))));

  const plan = planKeywordGroups(search.keyword_groups, shippedKeywordGroups(), draft.target_titles);
  const nextSearch = searchSchema.safeParse({ ...editable(search), keyword_groups: plan.groups });
  if (!nextSearch.success && !errors.some((e) => e.path === "target_titles")) errors.push(...zodSetupErrors(nextSearch.error, () => "target_titles"));
  if (errors.length > 0 || !nextSearch.success) return stepError("targets", null, errors);

  const problem = profileSaveProblem("targets", await saveProfile("preferences", draft));
  if (problem !== null) return problem;
  if (plan.mode !== "none") {
    try {
      await writeConfig("search", nextSearch.data);
    } catch (error) {
      return stepError("targets", setupWriteError(error));
    }
  }
  return finishStep("targets");
}
