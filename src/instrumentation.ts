/**
 * Next.js calls `register` once when the server starts (node runtime only: the filter patches `console`, the config
 * directory is on disk). It also reads the place dictionary right after the start, so the first page that looks a place up
 * does not wait for it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installClientAbortFilter } = await import("@/lib/ops/client-aborts");
  installClientAbortFilter();
  // Starting writes nothing to the config or profile directories: a missing file reads the shipped default.
  const { plannedConfigFiles } = await import("@/lib/config/init");
  const { ensureProfileFilesPlan } = await import("@/lib/config/profile");
  try {
    const missing = plannedConfigFiles().length + ensureProfileFilesPlan().length;
    if (missing > 0) console.log(`[config] ${missing} user file(s) missing: reading the shipped defaults`);
  } catch (error) {
    console.error(`[config] could not list the user config files: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Which shipped defaults this server runs with (for `pnpm run doctor`). Not awaited: the start-up never waits for the
  // database; a failed write is retried on the health checks.
  const { reportWebShippedConfig } = await import("@/lib/ops/shipped-config");
  void reportWebShippedConfig();
  const { warmPlaceDictionary } = await import("@/lib/market/geo/warm");
  setImmediate(warmPlaceDictionary);
}
