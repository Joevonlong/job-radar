import fs from "node:fs";

import type { ChannelLogger } from "@/lib/channels/types";
import { ConfigError, firstConfigProblem, reloadConfig, resolveConfigPath, type ModelsConfig } from "@/lib/config";

import { sanitize } from "./errors";

interface Memo {
  stamp: string;
  value: ModelsConfig | null;
}
const memo = new Map<string, Memo>();

/**
 * The model catalog for the AI layer, or null when `models.yaml` cannot be read. A broken catalog must not take
 * the AI layer down: the router then skips the API providers (no price, no budget) and the subscription CLIs go on.
 *
 * Unlike `loadConfig`, a broken file is not papered over with the last good value (the config watcher keeps that): the
 * file is re-read whenever its mtime or size changes, so a broken file is seen at once and a fixed one is picked up on
 * the next call, with no restart.
 */
export function loadModelCatalog(logger?: ChannelLogger): ModelsConfig | null {
  const file = resolveConfigPath("models"); // the user override, else the shipped default
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    stamp = "missing";
  }
  const hit = memo.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  let value: ModelsConfig | null = null;
  try {
    value = reloadConfig("models");
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logger?.warn("models.yaml could not be read", { error: sanitize(firstConfigProblem(error)) });
  }
  memo.set(file, { stamp, value });
  return value;
}

/** Forget the memo (tests). */
export function resetModelCatalogMemo(): void {
  memo.clear();
}
