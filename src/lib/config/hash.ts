import { createHash } from "node:crypto";

/** SHA-256 hex of a config file's text: how the runner and the settings page tell "the same file" apart. */
export function hashConfigText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
