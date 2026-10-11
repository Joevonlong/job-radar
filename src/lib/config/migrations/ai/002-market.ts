import type { ConfigMigration } from "../types";
import { renameKey } from "../edit";

/** ai.yaml 1 -> 2: the German deduction becomes the local-language deduction. */
export const ai002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "market packs: scoring.german_penalty -> language_penalty, priority.weights.german_gap -> language_gap",
  migrate(doc) {
    renameKey(doc, ["scoring"], "german_penalty", "language_penalty");
    renameKey(doc, ["scoring", "priority", "weights"], "german_gap", "language_gap");
  },
};
