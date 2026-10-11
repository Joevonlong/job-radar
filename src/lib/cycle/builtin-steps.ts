import { aiStep } from "@/lib/ai/step";
import { registerFilterStep } from "@/lib/filter";
import { registerNotifySteps } from "@/lib/notify";
import { notifyStep } from "@/lib/notify/step";
import { registerPipelineSteps } from "@/lib/pipeline";
import { registerScoringSubtask } from "@/lib/scoring";
import { registerSignalsAiSubtask, registerSignalsSteps } from "@/lib/signals";
import { registerBreakdownSubtask } from "@/lib/breakdown/subtask";
import { registerTrapsAiSubtask } from "@/lib/traps/ai-check";
import { registerTranslationSubtask } from "@/lib/translation/subtask";

import { createDelegatingAiStep, createDelegatingNotifyStep } from "./delegate";
import { registerCycleStep } from "./steps";

/**
 * Register the real cycle steps. Features that own a step (`pipeline` / `maintenance`, `filter`,
 * rule `signals`, `notify`) add their registration call here; the runner and `pnpm cycle:run` call this
 * once at start-up. AI sub-tasks are registered by `registerBuiltinAiSubtasks` instead.
 *
 * `ai` and `notify` are registered as delegating steps: with `ai.yaml: execution: host` they leave a `run_ai`
 * request for the ai-worker instead of running; with `execution: container` they run here as before. The ai-worker
 * itself never calls this: it runs the real `aiStep` / `notifyStep` directly (`runDelegatedSteps`).
 */
export function registerBuiltinCycleSteps(): void {
  registerPipelineSteps();
  registerFilterStep();
  registerSignalsSteps();
  registerNotifySteps();
  registerCycleStep("ai", createDelegatingAiStep(aiStep));
  registerCycleStep("notify", createDelegatingNotifyStep(notifyStep));
}

/**
 * Register the AI sub-tasks of the `ai` step (`score`, `signals`, `translate`), in this
 * order. Kept apart from the cycle steps on purpose: the runner and `pnpm cycle:run` call it, tests that run whole
 * cycles do not, so they can never reach a real AI provider.
 *
 * The weekly interests suggestion is not a per-cycle sub-task: it runs on its own weekly schedule as the
 * control request `run_suggest`, whose handler is registered with the other AI request handlers in
 * `registerAiControlHandlers()` (src/lib/control/ai-handlers.ts).
 */
export function registerBuiltinAiSubtasks(): void {
  // Before the scoring, so the scoring of the same cycle reads the JD without the traps the AI check finds
  registerTrapsAiSubtask();
  registerScoringSubtask();
  registerSignalsAiSubtask();
  registerTranslationSubtask();
  // After the translation; does nothing unless breakdown.yaml is enabled with mode: auto
  registerBreakdownSubtask();
}
