import { ConfigError, loadConfig } from "@/lib/config";
import type { RepliesConfig } from "@/lib/config/schemas/replies";

/** replies.yaml, or null when it cannot be read: a broken optional feature hides its panel, it does not break the page. Other errors are thrown. */
export function readRepliesSettings(load: () => RepliesConfig = () => loadConfig("replies")): RepliesConfig | null {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}
