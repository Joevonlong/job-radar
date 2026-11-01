import { breakdownJobHandler } from "./breakdown-job";
import { registerControlHandler } from "./handlers";
import { rescoreStaleHandler } from "./rescore";
import { salaryLookupHandler } from "./salary-lookup";
import { scoreJobsHandler } from "./score-jobs";
import { registerSuggestHandler } from "./suggest";
import { createRunAiHandler } from "./run-ai";
import { testAiHandler } from "./test-ai";
import { translateJobHandler } from "./translate-job";
import { writerJobHandler } from "./writer-job";

/**
 * The ONE place that plugs the real handlers of the AI-backed request kinds (`AI_CONTROL_REQUEST_KINDS`) in. The
 * ai-worker calls it at start-up; the container runner calls it too, but only claims those kinds with
 * `execution: container` (see `kinds.ts`). A new AI-backed kind adds its `registerControlHandler(...)` line here
 * (or inside `registerBuiltinAiSubtasks()`, which both processes call as well) and its name to
 * `AI_CONTROL_REQUEST_KINDS`; nothing else needs to change for the worker to run it and the runner to leave it alone.
 */
export function registerAiControlHandlers(): void {
  registerControlHandler("run_ai", createRunAiHandler());
  registerControlHandler("translate_job", translateJobHandler);
  registerControlHandler("breakdown_job", breakdownJobHandler);
  registerControlHandler("rescore_stale", rescoreStaleHandler);
  registerControlHandler("score_jobs", scoreJobsHandler);
  registerControlHandler("test_ai", testAiHandler);
  registerControlHandler("salary_lookup", salaryLookupHandler);
  registerControlHandler("writer_job", writerJobHandler);
  registerSuggestHandler();
}
