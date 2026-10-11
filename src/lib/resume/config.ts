import { loadConfig, reloadConfig, type ResumeConfig } from "@/lib/config";

/**
 * config/resume.yaml, re-read from disk on every call: the web process has no config watcher, and the
 * file is meant to be edited by hand while the dashboard is open. null when the file is missing or invalid
 * (the panel then says so instead of failing the whole page).
 */
export function readResumeConfig(): ResumeConfig | null {
  try {
    return reloadConfig("resume");
  } catch {
    return null;
  }
}

/**
 * Whether a resume-kit folder is configured (`resume_kit_path`), for the runner and the ai-worker (their watcher keeps the cache
 * current). The "Tailor resume" Telegram button is offered only then; an unreadable file counts as not configured.
 */
export function isResumeKitConfigured(): boolean {
  try {
    return loadConfig("resume").resume_kit_path !== null;
  } catch {
    return false;
  }
}
