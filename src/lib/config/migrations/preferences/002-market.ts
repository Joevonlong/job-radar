import type { ConfigMigration } from "../types";
import { insertFirst, renameKey } from "../edit";
import { LEGACY_MARKET, migrateRemoteScopeAt } from "../legacy-market";

/** preferences.yaml 1 -> 2: the market (Germany: the only market before), remote scope values renamed. */
export const preferences002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "market packs: add market (de), remote_scope eu_hire_in_de -> home_country, eu_any -> {region: [eu]}, salary_floor_eur_year -> salary_floor_year",
  migrate(doc) {
    insertFirst(doc, "market", { ...LEGACY_MARKET }, "市场：pack = 市场包；country / currency / home_language 不写时取包的值");
    migrateRemoteScopeAt(doc, ["remote_scope"]);
    // the floor is in the market's base currency, which is EUR for these files
    renameKey(doc, [], "salary_floor_eur_year", "salary_floor_year");
  },
};
