import type { ConfigMigration } from "../types";
import { insertAfter } from "../edit";

/**
 * pipeline.yaml 4 -> 5: `apply_priority` lists every channel family, and the new `berlinstartupjobs` family (a job board where
 * employers post directly) ranks with StepStone, XING and Indeed. Only a pipeline.yaml the user copied into the user directory
 * needs it; the shipped file has the key. No-op when the key exists or the file has no `apply_priority` mapping.
 */
export const pipeline005: ConfigMigration = {
  from: 4,
  to: 5,
  description: "apply_priority gets the new channel family berlinstartupjobs (3, like StepStone, XING and Indeed)",
  migrate(doc) {
    insertAfter(doc, ["apply_priority"], "indeed", "berlinstartupjobs", 3);
  },
};
