/**
 * The format boundary in a layered file's chain: from this version on the user's file holds only the keys that differ from the
 * shipped file. The step itself changes nothing in the document (the conversion in `files.ts` does); it is `convertOnly`,
 * so the loader and the writer stop before it and only `config:migrate --write --convert-overlays` crosses it.
 */
import type { ConfigMigration } from "./types";

export function overlayFormatStep(from: number): ConfigMigration {
  return {
    from,
    to: from + 1,
    convertOnly: true,
    description: "keep only the keys that differ from the shipped file; the rest follows the product",
    migrate() {
      // the conversion needs the shipped file: `convertOverlayDocument` in files.ts
    },
  };
}
