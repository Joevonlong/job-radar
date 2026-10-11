/**
 * The salary benchmark. Postings of the window with a comparable annual figure (`annualBaseFigure`, the base
 * currency) are grouped by role family x seniority x place on four levels: city, country, family x country (any
 * seniority), family only. Groups below `min_sample` are not kept. Optionally checked AI lookup bands join as extra
 * figures (counted apart). The whole table is rebuilt after each pipeline step (cheap: a few thousand rows).
 */
import type { ChannelLogger } from "@/lib/channels/types";
import type { SalaryConfig } from "@/lib/config";
import type { Executor } from "@/lib/db/executor";
import { listSalaryFigures, replaceSalaryBenchmarks, salaryTablesReady, type SalaryBenchmarkInput, type SalaryFigureRow } from "@/lib/db/repos/salary-benchmarks";
import { listSalaryObservations } from "@/lib/db/repos/salary-lookups";

import { compileFamilies, type FamilyMatcher } from "./families";
import type { SalaryObservation } from "./lookup-types";
import { quantile, quantilesOf } from "./percentile";

/** Any seniority / any place. */
export const ANY = "*";
export type GeoLevel = "city" | "country" | "all";

export const normCity = (city: string): string => city.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

interface Figure {
  family: string;
  seniority: string;
  city: string | null;
  country: string | null;
  value: number;
  ai: boolean;
}

/** The group keys one figure counts in (an unknown seniority only in the "any seniority" levels). */
export function groupKeys(figure: Pick<Figure, "family" | "seniority" | "city" | "country">): Array<{ seniority: string; geoLevel: GeoLevel; geoKey: string }> {
  const keys: Array<{ seniority: string; geoLevel: GeoLevel; geoKey: string }> = [];
  const known = figure.seniority !== "unknown" && figure.seniority !== "";
  if (known && figure.city) keys.push({ seniority: figure.seniority, geoLevel: "city", geoKey: normCity(figure.city) });
  if (known && figure.country) keys.push({ seniority: figure.seniority, geoLevel: "country", geoKey: figure.country.toUpperCase() });
  if (figure.country) keys.push({ seniority: ANY, geoLevel: "country", geoKey: figure.country.toUpperCase() });
  keys.push({ seniority: ANY, geoLevel: "all", geoKey: ANY });
  return keys;
}

/** Group, cut at `minSample`, and summarise (pure; the rows it returns are what the table holds). */
export function buildBenchmarkRows(input: {
  postings: readonly SalaryFigureRow[];
  observations: readonly SalaryObservation[];
  families: FamilyMatcher;
  currency: string;
  minSample: number;
}): SalaryBenchmarkInput[] {
  const figures: Figure[] = [];
  for (const row of input.postings) {
    const family = input.families.familyOf(row.title);
    if (family === null) continue;
    figures.push({ family, seniority: row.seniority.toLowerCase(), city: row.location?.city ?? null, country: row.location?.countryCode ?? null, value: row.figure, ai: false });
  }
  for (const observation of input.observations) {
    if (!input.families.families.some((family) => family.id === observation.family)) continue;
    figures.push({ family: observation.family, seniority: observation.seniority, city: observation.city, country: observation.country, value: observation.figure, ai: true });
  }
  const groups = new Map<string, { family: string; seniority: string; geoLevel: GeoLevel; geoKey: string; values: number[]; ai: number }>();
  for (const figure of figures) {
    for (const key of groupKeys(figure)) {
      const id = `${figure.family}\u0000${key.seniority}\u0000${key.geoLevel}\u0000${key.geoKey}`;
      let group = groups.get(id);
      if (!group) {
        group = { family: figure.family, ...key, values: [], ai: 0 };
        groups.set(id, group);
      }
      group.values.push(figure.value);
      if (figure.ai) group.ai += 1;
    }
  }
  const rows: SalaryBenchmarkInput[] = [];
  for (const group of groups.values()) {
    if (group.values.length < input.minSample) continue;
    const sorted = [...group.values].sort((a, b) => a - b);
    rows.push({
      roleFamily: group.family,
      seniority: group.seniority,
      geoLevel: group.geoLevel,
      geoKey: group.geoKey,
      currency: input.currency,
      n: sorted.length,
      nAi: group.ai,
      median: quantile(sorted, 0.5),
      quantiles: quantilesOf(sorted).map((value) => Math.round(value)),
    });
  }
  return rows.sort((a, b) => a.roleFamily.localeCompare(b.roleFamily) || a.seniority.localeCompare(b.seniority) || a.geoLevel.localeCompare(b.geoLevel) || a.geoKey.localeCompare(b.geoKey));
}

export interface BenchmarkRefreshResult {
  groups: number;
  postings: number;
  aiObservations: number;
  currency: string;
}

/** Rebuild `salary_benchmarks` from the database. Null when switched off or the tables are missing. */
export async function refreshSalaryBenchmark(db: Executor, input: { config: SalaryConfig; currency: string; now?: Date; logger?: ChannelLogger }): Promise<BenchmarkRefreshResult | null> {
  const { benchmark } = input.config;
  if (!benchmark.enabled) return null;
  if (!(await salaryTablesReady(db))) {
    input.logger?.warn("salary benchmark tables are missing (run the migrations)");
    return null;
  }
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - benchmark.window_days * 86_400_000);
  const postings = await listSalaryFigures(db, { currency: input.currency, since });
  const observations = benchmark.include_ai_lookups ? (await listSalaryObservations(db, { since })).filter((o) => o.currency === input.currency).flatMap((o) => o.observations) : [];
  const families = compileFamilies(input.config.role_families);
  const rows = buildBenchmarkRows({ postings, observations, families, currency: input.currency, minSample: benchmark.min_sample });
  await replaceSalaryBenchmarks(db, rows, now);
  return { groups: rows.length, postings: postings.length, aiObservations: observations.length, currency: input.currency };
}
