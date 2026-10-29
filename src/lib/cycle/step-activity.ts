import { reasonCodeSchema } from "@/lib/activity/names";
import type { TerminalStatus } from "@/lib/activity/types";
import type { StepResult } from "./steps";

/** Logging only: step results and the persisted business summary retain their original status. */
export function stepActivityOutcome(outcome?: StepResult | void): [TerminalStatus, string?] {
  const result = outcome?.result;
  if (typeof result === "object" && result !== null) {
    if ("skipped" in result && typeof result.skipped === "string") {
      const reason = reasonCodeSchema.safeParse(result.skipped);
      return ["skipped", reason.success ? reason.data : "other"];
    }
    if ("delegated" in result && result.delegated === true && (outcome?.status ?? "ok") === "ok") return ["skipped", "delegated"];
  }
  return [outcome?.status ?? "ok"];
}
