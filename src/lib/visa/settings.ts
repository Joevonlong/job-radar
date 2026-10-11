/**
 * The switches of the visa check: ui.yaml `job_checks.visa` (on / off, when the list badge and filter show) and me.yaml
 * `needs_visa_sponsorship`. The latter stays on this machine (C5): it is read here only to decide what the pages show.
 * Both are read from the file each time (two small files): the web app has no config watcher, and a hand edit of me.yaml or
 * ui.yaml must show on the next page load, as the settings and /me pages do.
 */
import { reloadConfig } from "@/lib/config";
import type { MeConfig } from "@/lib/config/schemas/me";
import { VISA_UI_DEFAULTS, type UiConfig, type VisaBadgeMode } from "@/lib/config/schemas/ui";

export interface VisaSettings {
  enabled: boolean;
  badges: VisaBadgeMode;
}

/**
 * ui.yaml `job_checks.visa`; when ui.yaml cannot be read the defaults apply (the check stays on: it changes nothing but what the
 * pages show, and a broken ui.yaml is reported by the settings page and `pnpm config:check`).
 */
export function readVisaSettings(load: () => Pick<UiConfig, "job_checks"> = () => reloadConfig("ui")): VisaSettings {
  try {
    return load().job_checks.visa;
  } catch {
    return { ...VISA_UI_DEFAULTS };
  }
}

/** me.yaml `needs_visa_sponsorship`; false when me.yaml is missing or cannot be read. */
export function readNeedsVisaSponsorship(load: () => Pick<MeConfig, "needs_visa_sponsorship"> = () => reloadConfig("me")): boolean {
  try {
    return load().needs_visa_sponsorship === true;
  } catch {
    return false;
  }
}

/** Whether the list badge and the /jobs filter show: the check is on, and `always`, or `auto` for a user who needs sponsorship. */
export function visaBadgesVisible(settings: VisaSettings, needsSponsorship: boolean): boolean {
  if (!settings.enabled) return false;
  return settings.badges === "always" || (settings.badges === "auto" && needsSponsorship);
}

/** `visaBadgesVisible` with the current config files. */
export function visaVisible(): boolean {
  const settings = readVisaSettings();
  return settings.enabled && visaBadgesVisible(settings, readNeedsVisaSponsorship());
}

/** Whether the check runs and the detail page shows its line (ui.yaml `job_checks.visa.enabled`). */
export function visaEnabled(): boolean {
  return readVisaSettings().enabled;
}
