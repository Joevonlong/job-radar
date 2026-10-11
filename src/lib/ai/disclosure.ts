import type { AiConfig } from "@/lib/config";
import { AI_PROVIDER_CONFIG_KEYS } from "@/lib/config/ai-options";

import { resolveProviderOrder } from "./router";
import { AI_TASKS, type AiProviderId, type AiTask } from "./types";
import { isWebTask, webCapable } from "./web-tasks";

/** One AI task and the providers that may receive its text, in the order they are tried. */
export interface AiDisclosureRow {
  task: AiTask;
  /** The enabled providers of the task's effective order (empty: the task cannot run). */
  providers: AiProviderId[];
  /** The task searches the web (only providers that can are listed). */
  web: boolean;
}

/**
 * Per AI task, which providers may receive job text: the task's effective order (`tasks.<task>.order`, else the global `order`, `api`
 * expanded to `api_order`) without the providers that are switched off, and for a web task only those that can search the web. A
 * provider later in the list receives the text only when the ones before it fail, but any of them may.
 */
export function aiDisclosure(config: AiConfig): AiDisclosureRow[] {
  return AI_TASKS.map((task) => {
    const web = isWebTask(task);
    const providers = resolveProviderOrder(config, task).filter((id) => config.providers[AI_PROVIDER_CONFIG_KEYS[id]].enabled && (!web || webCapable(id)));
    return { task, providers, web };
  });
}
