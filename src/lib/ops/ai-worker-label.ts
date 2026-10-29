import { execFileSync } from "node:child_process";
import path from "node:path";

import { z } from "zod";

import { getAppRoot } from "@/lib/config/paths";

const labelSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

/**
 * Resolve the configured scalar with the same function used by install, uninstall, deploy and restore. The resolver
 * stays in the shell library so file-only operations (including uninstall and --print-release) still need no Node.
 * Arguments are passed literally; resolving a label never queries or changes a service manager.
 */
export function aiWorkerLaunchdLabel(configured: string, timeoutMs?: number): string {
  const stdout = execFileSync("/bin/bash", [
    "-c", 'source "$1" && ai_worker_resolve_launchd_label "$2"', "ai-worker-label",
    path.join(getAppRoot(), "scripts/ops/lib/ai-worker.sh"), configured,
  ], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  return labelSchema.parse(stdout);
}
