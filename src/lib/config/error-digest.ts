/** Only a safe file identifier crosses the Server Component boundary; never a path, value or validation message. */
export const CONFIG_ERROR_DIGEST_PREFIX = "job-radar:config:";
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]*(?:\.yaml)?$/;
// Keep this client-safe module independent of the registry's server-side schema dependencies.
const FILE_STEMS: Readonly<Record<string, string>> = {
  channels: "sources",
  jobSearch: "job-search",
  pipelineBoard: "pipeline-board",
  signalPresets: "signal-presets",
  activityLog: "activity-log",
  deliveryAudit: "delivery-audit",
  jobArchive: "job-archive",
};

export function configErrorDigest(name: string): string {
  return `${CONFIG_ERROR_DIGEST_PREFIX}${name.length <= 60 && IDENTIFIER.test(name) ? name : ""}`;
}

export function configFileFromDigest(digest: string): string | null {
  const name = digest.slice(CONFIG_ERROR_DIGEST_PREFIX.length);
  if (!digest.startsWith(CONFIG_ERROR_DIGEST_PREFIX) || name.length > 60 || !IDENTIFIER.test(name)) return null;
  const stem = Object.hasOwn(FILE_STEMS, name) ? FILE_STEMS[name] : name;
  return stem.endsWith(".yaml") ? stem : `${stem}.yaml`;
}
