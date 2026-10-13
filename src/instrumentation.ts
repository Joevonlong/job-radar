/**
 * Next.js calls `register` once when the server starts (node runtime only: the filter patches `console`, the config
 * directory is on disk).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installClientAbortFilter } = await import("@/lib/ops/client-aborts");
  installClientAbortFilter();
  // The user config directory gets the user files it lacks from the defaults (never overwrites); the web is the
  // process that owns that directory. A failure only means the defaults are read until a save creates the file.
  const { ensureConfigFiles } = await import("@/lib/config/init");
  try {
    const created = (await ensureConfigFiles()).filter((r) => r.created).map((r) => r.name);
    if (created.length > 0) console.log(`[config] created user config files: ${created.join(", ")}`);
  } catch (error) {
    console.error(`[config] could not fill the user config directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Which shipped defaults this server runs with (for `pnpm run doctor`). Not awaited: the start-up never waits for the
  // database; a failed write is retried on the health checks.
  const { reportWebShippedConfig } = await import("@/lib/ops/shipped-config");
  void reportWebShippedConfig();
}
