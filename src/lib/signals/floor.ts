import { loadConfig, type InterestsConfig } from "@/lib/config";
import type { HighValuePolicy } from "@/lib/db/queries/signal-filter";
import { loadMarket } from "@/lib/market/resolve";

import { bonusPolicy, highValuePolicy, type BonusPolicy } from "./bonus";
import { buildCatalog, type SignalCatalog } from "./catalog";

/** `salary_floor_year` of preferences.yaml, or null when that file cannot be read (then no minimum applies). */
export function loadSalaryFloor(): number | null {
  try {
    return loadConfig("preferences").salary_floor_year;
  } catch {
    return null;
  }
}

/** The market's base currency, or null when the market cannot be resolved (then no amount is compared). */
export function loadBaseCurrency(): string | null {
  try {
    return loadMarket().currency;
  } catch {
    return null;
  }
}

/** The amount category's bonus policy for the current config files. */
export function loadBonusPolicy(interests: InterestsConfig = loadConfig("interests")): BonusPolicy {
  return bonusPolicy(interests, loadSalaryFloor(), loadBaseCurrency());
}

/** The high-value rule for the current config files. */
export function loadHighValuePolicy(interests: InterestsConfig = loadConfig("interests")): HighValuePolicy {
  return highValuePolicy(interests, loadSalaryFloor(), loadBaseCurrency());
}

/** The category catalog of the current interests.yaml, or null when it cannot be read (callers then show no categories). */
export function loadSignalCatalog(): SignalCatalog | null {
  try {
    return buildCatalog(loadConfig("interests"));
  } catch {
    return null;
  }
}
