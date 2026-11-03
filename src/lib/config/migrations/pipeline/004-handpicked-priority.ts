import type { ConfigMigration } from "../types";
import { insertAfter } from "../edit";

/**
 * pipeline.yaml 3 -> 4: `apply_priority` lists every channel family, and the new `handpicked` family (links straight to the
 * employer's own posting) ranks with LinkedIn. Only a pipeline.yaml the user copied into the user directory needs it; the
 * shipped file has the key. No-op when the key exists or the file has no `apply_priority` mapping.
 */
export const pipeline004: ConfigMigration = {
  from: 3,
  to: 4,
  description: "apply_priority gets the new channel family handpicked (2, like LinkedIn)",
  migrate(doc) {
    insertAfter(doc, ["apply_priority"], "linkedin", "handpicked", 2);
  },
};
