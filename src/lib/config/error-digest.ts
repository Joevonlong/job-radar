/** Only a safe file identifier crosses the Server Component boundary; never a path, value or validation message. */
export const CONFIG_ERROR_DIGEST_PREFIX = "job-radar:config:";
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]*(?:\.yaml)?$/;

export function configErrorDigest(name: string): string {
  return `${CONFIG_ERROR_DIGEST_PREFIX}${name.length <= 60 && IDENTIFIER.test(name) ? name : ""}`;
}

export function configFileFromDigest(digest: string): string | null {
  const name = digest.slice(CONFIG_ERROR_DIGEST_PREFIX.length);
  if (!digest.startsWith(CONFIG_ERROR_DIGEST_PREFIX) || name.length > 60 || !IDENTIFIER.test(name)) return null;
  const stem = name === "channels" ? "sources" : name === "signalPresets" ? "signal-presets" : name;
  return stem.endsWith(".yaml") ? stem : `${stem}.yaml`;
}
