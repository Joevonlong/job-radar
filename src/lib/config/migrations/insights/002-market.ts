import type { ConfigMigration } from "../types";
import { renameKey } from "../edit";

/** insights.yaml 1 -> 2: the salary buckets are in the market's base currency (EUR for these files). */
export const insights002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "market packs: salary_bucket_eur -> salary_bucket, salary_bucket_cap_eur -> salary_bucket_cap",
  migrate(doc) {
    renameKey(doc, [], "salary_bucket_eur", "salary_bucket");
    renameKey(doc, [], "salary_bucket_cap_eur", "salary_bucket_cap");
  },
};
