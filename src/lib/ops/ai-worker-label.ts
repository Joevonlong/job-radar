import { z } from "zod";

export const AI_WORKER_DEFAULT_LAUNCHD_LABEL = "io.jobradar.ai-worker";

const labelSchema = z.string().min(1).refine((label) => !/[^A-Za-z0-9._-]/.test(label), {
  message: "doctor.ai_worker_launchd_label must contain only letters, digits, . _ -",
});

/**
 * Keep valid configured labels literally; only missing / empty values select the default. The shell equivalent is
 * ai_worker_resolve_launchd_label in scripts/ops/lib/ai-worker.sh; tests/ops/ai-worker-label.test.ts enforces parity.
 */
export function aiWorkerLaunchdLabel(configured?: string): string {
  return labelSchema.parse(configured === undefined || configured === "" ? AI_WORKER_DEFAULT_LAUNCHD_LABEL : configured);
}
