import type { JobSourceRef } from "@/lib/db/queries/types";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { foldText, wholeWordPattern } from "@/lib/filter/rules";

/**
 * Statuses from which "Mark applied" is offered. A state-machine rule, not a threshold: once an application is
 * further along (interviewing, offer, rejected, withdrawn) a click must not pull it back to `applied`.
 */
export const MARK_APPLIED_FROM: readonly ApplicationStatus[] = ["new", "interested", "preparing", "archived"];

/** The direct apply link of a source when the channel gave one, else its posting URL (the resume export's `apply_url`). */
export function sourceLink(source: Pick<JobSourceRef, "applyUrl" | "url">): string | null {
  return source.applyUrl ?? source.url;
}

/**
 * The link "View posting" opens for a source. On an employer's ATS board the apply link is the application
 * form (Ashby `.../application`), so the posting page wins and the apply link is only the fallback. On an aggregator
 * (LinkedIn, JSearch, Indeed ...) the apply link is the employer's direct page that the channel picked on purpose
 * (JSearch ranks it by `apply_publisher_preference`), and the listing URL is the aggregator's own page, so the apply
 * link stays first there. Opening it never changes the application status.
 */
export function postingLink(source: Pick<JobSourceRef, "applyUrl" | "url" | "family">): string | null {
  return source.family === "ats" ? (source.url ?? source.applyUrl) : (source.applyUrl ?? source.url);
}

/** Names of the wanted cities (spellings from `filter.city_aliases`) and their metro towns, for `pickApplyTarget`. */
export function targetPlaceNames(
  preferences: { locations: readonly string[] },
  filter: { city_aliases: Readonly<Record<string, readonly string[]>>; metro_areas: Readonly<Record<string, readonly string[]>> },
): string[] {
  const group = (name: string): string[] => {
    const hit = Object.entries(filter.city_aliases).find(([canonical, aliases]) => [canonical, ...aliases].some((n) => foldText(n) === foldText(name)));
    return hit ? [hit[0], ...hit[1]] : [name];
  };
  const names = new Set<string>();
  for (const location of preferences.locations) {
    const spellings = group(location);
    for (const n of spellings) names.add(n);
    for (const [city, towns] of Object.entries(filter.metro_areas)) if (spellings.some((n) => foldText(n) === foldText(city))) for (const t of towns) names.add(t);
  }
  return [...names];
}

/**
 * The "View posting" target: among the sources that have a link, those whose location names one of the wanted places
 * (`places`, see `targetPlaceNames`) come first, then the best (lowest) priority wins. A multi-site posting thus
 * opens its Berlin / München link rather than Amsterdam. Sources arrive sorted, but this does not rely on it.
 */
export function pickApplyTarget(sources: readonly JobSourceRef[], places: readonly string[] = []): JobSourceRef | null {
  const patterns = places.map((name) => wholeWordPattern(foldText(name)));
  const wanted = (source: JobSourceRef): boolean => {
    if (!source.locationLabel) return false;
    const label = foldText(source.locationLabel);
    return patterns.some((p) => p.test(label));
  };
  let best: JobSourceRef | null = null;
  for (const source of sources) {
    if (!postingLink(source)) continue;
    if (best === null) best = source;
    else if (wanted(source) !== wanted(best)) best = wanted(source) ? source : best;
    else if (source.priority < best.priority) best = source;
  }
  return best;
}

/** Only http(s) URLs become links (a source URL is external data). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Distinct source families in apply-priority order, for the little icons on a row. */
export function distinctFamilies(sources: readonly JobSourceRef[]): string[] {
  const seen = new Set<string>();
  for (const source of sources) seen.add(source.family);
  return [...seen];
}
