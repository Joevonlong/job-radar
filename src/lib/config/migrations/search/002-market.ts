import type { ConfigMigration } from "../types";
import { migrateRemoteScopeAt } from "../legacy-market";

/** search.yaml 1 -> 2: remote scope values renamed. */
export const search002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "market packs: remote_scope eu_hire_in_de -> home_country, eu_any -> {region: [eu]}",
  migrate(doc) {
    migrateRemoteScopeAt(doc, ["remote_scope"]);
  },
};
