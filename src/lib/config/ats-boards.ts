import { loadConfig } from "./load";
import type { CompaniesConfig } from "./schemas/companies";

/** The ATS boards to collect: `ats_boards` of config/sources.yaml, in the shape the ATS channels expect. */
export function loadCompanies(): CompaniesConfig {
  return { companies: loadConfig("channels").ats_boards };
}
