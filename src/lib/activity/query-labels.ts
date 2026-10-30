import { buildQueries, buildSweepQuery } from "@/lib/channels/query";
import type { SearchConfig } from "@/lib/config";
import type { ActivityTranslator } from "./messages";

/** Only the current, trusted search config supplies free-text query labels. Never use stored query text. */
export function resolveQueryLabels(search: SearchConfig, t: ActivityTranslator): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const query of buildQueries(search, "manual")) {
    labels[query.id] = `${query.keywords.join(" / ")} · ${query.location ?? t("remote")}`;
  }
  labels[buildSweepQuery(search, "manual").id] = t("sweep");
  return labels;
}

export function queryLabel(labels: Record<string, string>, id: string | null, t: ActivityTranslator): string {
  return (id === null ? undefined : labels[id]) ?? t("query", { id: id?.slice(0, 8) ?? t("unknown") });
}
