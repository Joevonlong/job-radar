/** Saved views for the pages (server only): read from interests.yaml on every request, so hand edits show up. */
import { ConfigError, reloadConfig } from "@/lib/config";
import type { SavedView } from "@/lib/config/schemas/interests";

/** The saved views; empty when interests.yaml cannot be loaded (the pages keep working without views). */
export function loadSavedViews(): SavedView[] {
  try {
    return [...reloadConfig("interests").views];
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
}
