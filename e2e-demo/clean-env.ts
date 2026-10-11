/**
 * A clean environment for the demo web server. `next build` / `next start` load the project's `.env`, but never override a
 * variable that is already set (an empty string counts as set). Every variable `.env.example` lists is therefore set to
 * the empty string, as are the ones a shell may carry, so the owner's real `.env` cannot show up in a screenshot (no
 * "configured" channel, no key). Only the values the demo needs are put back by the caller.
 */
import fs from "node:fs";
import path from "node:path";

/** Variables the app reads that are not in `.env.example` (set by the compose file or by hand). */
const EXTRA_NAMES = ["JOB_RADAR_WEB_PASSWORD", "DATABASE_URL", "JOB_RADAR_CONFIG_DIR", "JOB_RADAR_PROFILE_DIR", "JOB_RADAR_DEFAULTS_DIR"];

/** The variable names of an `.env.example` text (`NAME=` lines, commented-out ones too). */
export function envExampleNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return [...names];
}

/** Every listed variable (and the extra ones) as the empty string. */
export function blankEnv(repoRoot: string): Record<string, string> {
  const text = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  return Object.fromEntries([...envExampleNames(text), ...EXTRA_NAMES].map((name) => [name, ""]));
}
