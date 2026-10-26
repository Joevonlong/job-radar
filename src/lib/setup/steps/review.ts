/**
 * Setup step 8 and the step-independent actions: skip a step, skip the whole wizard, run the first cycle, finish.
 */
import { requestRunCycle, type ControlActionState } from "@/lib/control/service";

import { completeSetup, markStep, readSetupState } from "../state";
import { isSetupStepId, type SetupCompletedBy } from "../steps";
import { setupFrozen } from "./common";
import { stepError, type SetupStepResult } from "../types";
import { disableTelegramIfUnconfigured } from "./telegram";

/**
 * "Skip": records `skipped`. The only config it writes is the Telegram switch (off when no bot is configured, so the
 * push does not complain on every cycle). `raw` is untrusted.
 */
export async function skipSetupStep(raw: unknown): Promise<SetupStepResult> {
  const frozen = setupFrozen("review");
  if (frozen) return frozen;
  if (!isSetupStepId(raw)) return stepError("review", "invalidPayload");
  if (raw === "telegram") await disableTelegramIfUnconfigured();
  const marked = await markStep(raw, "skipped");
  return marked.ok ? { status: "skipped", step: raw } : stepError(raw, marked.reason === "frozen" ? "frozen" : "setupUnreadable");
}

/** Mark the whole setup complete (`wizard` after the review step, `skipped` for "skip the wizard", `cli` from the command line). */
export async function finishSetup(by: SetupCompletedBy): Promise<SetupStepResult> {
  const frozen = setupFrozen("review");
  if (frozen) return frozen;
  // never on an install from before the wizard: its notify.yaml is the user's own
  const current = readSetupState();
  if (by === "skipped" && current.source !== "existing_install" && current.state?.completed_by !== "existing_install" && current.state?.steps.telegram?.status !== "done") await disableTelegramIfUnconfigured();
  if (by === "wizard" || by === "cli") {
    const marked = await markStep("review", "done");
    if (!marked.ok) return stepError("review", marked.reason === "frozen" ? "frozen" : "setupUnreadable");
  }
  const done = await completeSetup(by);
  return done.ok ? { status: "saved", step: "review" } : stepError("review", done.reason === "frozen" ? "frozen" : "setupUnreadable");
}

/** "Run the first cycle now": a manual cycle request (it runs while the setup is pending; an open request is reused). */
export async function requestFirstCycle(): Promise<ControlActionState> {
  return requestRunCycle({});
}
