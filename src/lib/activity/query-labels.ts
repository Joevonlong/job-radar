import { buildCompanyQueries, buildQueries, buildSweepQuery } from "@/lib/channels/query";
import type { WatchedCompanyBoard } from "@/lib/companies/watched-boards";
import { z } from "zod";
import type { SearchConfig } from "@/lib/config";
import type { ActivityTranslator } from "./messages";

/** Only the current, trusted search config supplies free-text query labels. Never use stored query text. */
export function resolveQueryLabels(search: SearchConfig, t: ActivityTranslator, companies: readonly WatchedCompanyBoard[] = [], historicalKeys: Record<string, string> = {}): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [id, key] of Object.entries(historicalKeys)) labels[id] = t("company", { name: key });
  // A board or opt-out added later must not erase labels of previous company queries.
  const companySearch = { ...search, watched_company_queries: { ...search.watched_company_queries, enabled: true } };
  for (const query of buildCompanyQueries(companySearch, companies.map((entry) => ({ ...entry, hasBoard: false })), 0)) {
    labels[query.id] = t("company", { name: query.company!.name });
  }
  for (const query of buildQueries(search, "manual")) {
    labels[query.id] = `${query.keywords.join(" / ")} · ${query.location ?? t("remote")}`;
  }
  labels[buildSweepQuery(search, "manual").id] = t("sweep");
  return labels;
}

/**
 * The live watch list for labels. Reading it needs the pipeline config; when that (or the watch list) cannot be read,
 * labels fall back to the company keys stored in the cycle summary instead of failing the activity page.
 */
export function liveCompanyBoards(read: () => readonly WatchedCompanyBoard[], onError: (error: unknown) => void = () => {}): readonly WatchedCompanyBoard[] {
  try {
    return read();
  } catch (error) {
    onError(error);
    return [];
  }
}

/** Cycle summaries are an external JSON boundary; malformed or older rows simply have no company keys. */
export function storedCompanyQueryKeys(summary: unknown): Record<string, string> {
  const shape = z.object({ steps: z.array(z.object({ name: z.string(), result: z.unknown().optional() })) });
  const parsed = shape.safeParse(summary);
  if (!parsed.success) return {};
  const result = z.object({ companyQueryKeys: z.record(z.string().regex(/^[a-f0-9]{16}$/), z.string().min(1).max(200)).optional() })
    .safeParse(parsed.data.steps.find((step) => step.name === "collect")?.result);
  return result.success ? result.data.companyQueryKeys ?? {} : {};
}

export function queryLabel(labels: Record<string, string>, id: string | null, t: ActivityTranslator): string {
  return (id === null ? undefined : labels[id]) ?? t("query", { id: id?.slice(0, 8) ?? t("unknown") });
}
