import type { ConfigMigration } from "../types";
import { insertAfter } from "../edit";

/**
 * pipeline.yaml 2 -> 3: `apply_priority` lists every channel family, and the new `arbeitnow` family (an aggregator, like
 * arbeitsagentur and google) gets the aggregator priority. Only a pipeline.yaml the user copied into the user directory needs
 * it; the shipped file has the key. No-op when the key exists or the file has no `apply_priority` mapping.
 */
export const pipeline003: ConfigMigration = {
  from: 2,
  to: 3,
  description: "apply_priority gets the new channel family arbeitnow (4, like the other aggregators)",
  migrate(doc) {
    insertAfter(doc, ["apply_priority"], "arbeitsagentur", "arbeitnow", 4);
  },
};
