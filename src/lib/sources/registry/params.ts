/** URL state of /sources/registry: shared by the client explorer (nuqs hooks) and tests. Unknown values read as "not set". */
import { parseAsNativeArrayOf, parseAsString, parseAsStringLiteral } from "nuqs/server";

import { ATS_KINDS } from "@/lib/config/schemas/companies";

import { REGISTRY_STATUSES } from "./status";

export const REGISTRY_TYPE_FILTERS = ["all", "channel", "ats_board"] as const;
export type RegistryTypeFilter = (typeof REGISTRY_TYPE_FILTERS)[number];

/** Longest search text kept from the URL. */
export const REGISTRY_QUERY_MAX = 100;

export const registryParsers = {
  type: parseAsStringLiteral(REGISTRY_TYPE_FILTERS).withDefault("all"),
  /** Repeated keys (`?status=failing&status=degraded`), like /jobs. */
  status: parseAsNativeArrayOf(parseAsStringLiteral(REGISTRY_STATUSES)).withDefault([]),
  /** Only the boards of this ATS. */
  ats: parseAsStringLiteral(ATS_KINDS),
  q: parseAsString.withDefault(""),
};
