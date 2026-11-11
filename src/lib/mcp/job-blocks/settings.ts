/** All configuration used by job blocks is read lazily; unreadable inputs yield the page's unset results. */
import { loadConfig, reloadConfig } from "@/lib/config";
import { loadDealBreakerNotice } from "@/lib/dashboard/deal-breakers";
import { userGermanLabelOrNull } from "@/lib/dashboard/german";
import { ghostEnabled } from "@/lib/ghost/settings";
import { loadPipeline } from "@/lib/market";
import { readSalarySettings } from "@/lib/salary/settings";
import { loadBaseCurrency, loadSalaryFloor } from "@/lib/signals/floor";
import { readNeedsVisaSponsorship, visaEnabled } from "@/lib/visa/settings";

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function lazy<T>(read: () => T, fallback: T): () => T {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: safe(read, fallback) };
    return cached.value;
  };
}

export function jobBlockSettings() {
  return {
    ghostEnabled: lazy(ghostEnabled, false),
    visaEnabled: lazy(visaEnabled, false),
    needsVisaSponsorship: lazy(readNeedsVisaSponsorship, false),
    salary: lazy(() => {
      const settings = readSalarySettings();
      return settings.state === "ok" ? settings.config : null;
    }, null),
    ai: lazy(() => reloadConfig("ai"), null),
    skills: lazy(() => loadConfig("me").skills.map((skill) => skill.name), []),
    skillAliases: lazy(() => loadPipeline().skills, []),
    germanLabel: lazy(userGermanLabelOrNull, null),
    salaryFloor: lazy(loadSalaryFloor, null),
    baseCurrency: lazy(loadBaseCurrency, null),
    dealBreakers: (...args: Parameters<typeof loadDealBreakerNotice>) => safe(() => loadDealBreakerNotice(...args), undefined),
  };
}
