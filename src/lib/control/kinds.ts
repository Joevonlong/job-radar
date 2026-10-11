import type { AiConfig } from "@/lib/config";
import { AI_CONTROL_REQUEST_KINDS, NON_AI_CONTROL_REQUEST_KINDS, type ControlRequestKind } from "@/lib/db/repos/control-requests";

type Execution = AiConfig["execution"];

/**
 * The request kinds the container runner claims: the kinds that call no AI, always; the AI kinds only with
 * `ai.yaml: execution: container` (and never `run_ai`, which only exists to hand a cycle's AI steps to the worker).
 * With `host` a request kind that is in neither list is claimed by nobody, so a forgotten new kind can never run
 * in the container by accident.
 */
export function runnerRequestKinds(execution: Execution): ControlRequestKind[] {
  return execution === "container" ? [...NON_AI_CONTROL_REQUEST_KINDS, ...AI_CONTROL_REQUEST_KINDS.filter((kind) => kind !== "run_ai")] : [...NON_AI_CONTROL_REQUEST_KINDS];
}

/**
 * The request kinds the host ai-worker claims: every AI kind while `execution: host`; with `container` only
 * `run_ai` (requests left over from a cycle that delegated before the switch).
 */
export function aiWorkerRequestKinds(execution: Execution): ControlRequestKind[] {
  return execution === "host" ? [...AI_CONTROL_REQUEST_KINDS] : ["run_ai"];
}
