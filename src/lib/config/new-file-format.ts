/**
 * The format of a config file that is created now (a form save, the editor, a repair, `config:init`, a source import).
 *
 * Formats only change in a deploy's write step. While any layered user file is still a whole file, a conversion is pending
 * and processes of the previous version may still run: they read whole files only, so a new file is written whole too (the
 * version before the overlay format), and that deploy step converts it. Otherwise it is an overlay. A new install has no user
 * files at all: overlays from the start.
 */
import { documentConfigVersion, hasOverlayFormat, isOverlayVersion } from "./migrations/version";
import { readOverlayText } from "./paths";
import { LAYERED_CONFIG_NAMES } from "./registry";
import { parseConfigYamlDocument } from "./yaml-options";

export type NewFileFormat = "legacy" | "overlay";

export function newFileFormat(): NewFileFormat {
  for (const name of LAYERED_CONFIG_NAMES) {
    if (!hasOverlayFormat(name)) continue;
    let text: string | null;
    try {
      text = readOverlayText(name);
    } catch {
      return "legacy"; // cannot tell, so assume the state that does not change a format
    }
    if (text === null) continue;
    const doc = parseConfigYamlDocument(text, { unset: "overlay" });
    if (doc.errors.length > 0 || !isOverlayVersion(name, documentConfigVersion(doc))) return "legacy";
  }
  return "overlay";
}
