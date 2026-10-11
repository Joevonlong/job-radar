/** ui.yaml `web_access` (the limits around the optional web password), read tolerantly. Server / Node only. */
import { reloadConfig } from "@/lib/config/load";
import { WEB_ACCESS_DEFAULTS, type UiConfig } from "@/lib/config/schemas/ui";

export type WebAccessSettings = UiConfig["web_access"];

/** The block as saved, or the defaults when ui.yaml cannot be read (a broken file must not lock the owner out). */
export function webAccessSettings(): WebAccessSettings {
  try {
    return reloadConfig("ui").web_access;
  } catch {
    return WEB_ACCESS_DEFAULTS;
  }
}
