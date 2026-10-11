import { closeDb, getDb } from "@/lib/db";
import { loadRunnerEnv } from "@/lib/env";
import { checkRunnerHealth } from "@/lib/ops/runner-health";

/**
 * Container healthcheck of the runner (compose.yaml `runner.healthcheck`): exit 0 while the newest
 * `runner_heartbeats` row is younger than RUNNER_HEALTH_MAX_AGE_SECONDS, exit 1 otherwise. Prints one
 * JSON line (visible in `docker inspect`). It needs only DATABASE_URL; nothing secret is printed.
 */
async function main(): Promise<number> {
  const env = loadRunnerEnv();
  try {
    const health = await checkRunnerHealth(getDb(), { maxAgeSeconds: env.RUNNER_HEALTH_MAX_AGE_SECONDS });
    console.log(JSON.stringify(health));
    return health.healthy ? 0 : 1;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.log(JSON.stringify({ healthy: false, reason: error instanceof Error ? error.name : "unknown error" }));
    process.exit(1);
  },
);
