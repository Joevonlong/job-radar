/** Setup step 3: about me (me.yaml), through the profile page's own save (validation, comments kept, history snapshot). */
import { saveProfile } from "@/lib/profile/service";

import { profileInputSchema } from "../inputs";
import { stepError, type SetupStepResult } from "../types";
import { finishStep, profileSaveProblem, setupFrozen } from "./common";

export async function saveProfileStep(raw: unknown): Promise<SetupStepResult> {
  const frozen = setupFrozen("profile");
  if (frozen) return frozen;
  const parsed = profileInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("profile", "invalidPayload");
  const problem = profileSaveProblem("profile", await saveProfile("me", parsed.data));
  return problem ?? finishStep("profile");
}
