import { createHash } from "node:crypto";

import { readOverlayText, readShippedText } from "./paths";
import { isProfileName, type ConfigName } from "./registry";

/** SHA-256 hex of a text: the bytes of one file (a profile file, the write lock's base check). */
export function hashConfigText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * What a config's effective value is made of, as one hash: the content of both layers, never their paths. Any change in
 * either layer changes it, and no user file differs from an empty one (the marker cannot be a file's first byte in UTF-8).
 */
export function layeredFingerprint(overlay: string | null, shipped: string | null): string {
  return createHash("sha256")
    .update(overlay === null ? "\xff" : `${overlay}`, "utf8")
    .update("\u0000", "utf8")
    .update(shipped === null ? "\xff" : `${shipped}`, "utf8")
    .digest("hex");
}

/**
 * The fingerprint of a config as it is on disk. How the forms, the editor, the "loaded" acknowledgement and the source
 * registry's mirror tell "the same config" apart. A profile file has no second layer: its template only counts while
 * there is no file. Throws ConfigError(read) when a layer cannot be read.
 */
export function layeredConfigFingerprint(name: ConfigName): string {
  const overlay = readOverlayText(name);
  return layeredFingerprint(overlay, isProfileName(name) && overlay !== null ? null : readShippedText(name));
}
