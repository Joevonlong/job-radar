"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/i18n/locale";
import type { ControlActionState } from "@/lib/control/service-types";
import { saveAiStep } from "@/lib/setup/steps/ai";
import { saveLanguageStep } from "@/lib/setup/steps/language";
import { saveMarketStep } from "@/lib/setup/steps/market";
import { saveProfileStep } from "@/lib/setup/steps/profile";
import { finishSetup, requestFirstCycle, skipSetupStep } from "@/lib/setup/steps/review";
import { saveSourcesStep } from "@/lib/setup/steps/sources";
import { saveTargetsStep } from "@/lib/setup/steps/targets";
import { saveTelegramStep } from "@/lib/setup/steps/telegram";
import { SETUP_STEP_IDS } from "@/lib/setup/steps";
import type { SetupActionState, SetupStepResult } from "@/lib/setup/types";

// Server Actions are public POST endpoints. Every input is validated again in the step services (zod, C6), and
// the web server only listens on 127.0.0.1 / Tailscale (C5). Nothing returned here carries a secret value.

const savableStep = z.enum(SETUP_STEP_IDS).exclude(["review"]);

function stamped(result: SetupStepResult): SetupActionState {
  // every step writes files other pages read: drop their cached render
  if (result.status !== "error") revalidatePath("/", "layout");
  return { ...result, nonce: Date.now() };
}

/** "Save and continue" of one step. `step` and `input` are untrusted. */
export async function saveSetupStepAction(step: unknown, input: unknown): Promise<SetupActionState> {
  const parsed = savableStep.safeParse(step);
  if (!parsed.success) return { status: "error", step: "review", fieldErrors: [], formError: "invalidPayload", nonce: Date.now() };
  switch (parsed.data) {
    case "language": {
      const result = await saveLanguageStep(input);
      if (result.status === "saved" && result.locale !== undefined) {
        // the wizard switches language at once: the same cookie as the language toggle
        (await cookies()).set(LOCALE_COOKIE, result.locale, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });
      }
      return stamped(result);
    }
    case "market":
      return stamped(await saveMarketStep(input));
    case "profile":
      return stamped(await saveProfileStep(input));
    case "targets":
      return stamped(await saveTargetsStep(input));
    case "sources":
      return stamped(await saveSourcesStep(input));
    case "ai":
      return stamped(await saveAiStep(input));
    case "telegram":
      return stamped(await saveTelegramStep(input));
  }
}

/** "Skip": records the step as skipped. Writes no config, except that skipping Telegram switches `telegram.enabled` off when no bot is configured. */
export async function skipSetupStepAction(step: unknown): Promise<SetupActionState> {
  return stamped(await skipSetupStep(step));
}

/** "Skip the wizard, I'll configure it myself": marks the setup complete (`completed_by: skipped`); like skipping Telegram, it switches `telegram.enabled` off when no bot is configured and the step was not saved. */
export async function skipWizardAction(): Promise<SetupActionState> {
  return stamped(await finishSetup("skipped"));
}

/** "Finish" on the review step. */
export async function finishSetupAction(): Promise<SetupActionState> {
  return stamped(await finishSetup("wizard"));
}

/** "Run the first cycle now": a manual cycle request (runs while the setup is pending). */
export async function runFirstCycleAction(): Promise<ControlActionState> {
  return requestFirstCycle();
}
