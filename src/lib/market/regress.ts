/**
 * `pnpm market:regress` — what the market-dependent steps decided for every job, saved before and after a change
 * (another code version, another market) and compared. A snapshot holds only derived values (country codes, levels,
 * flags, filter reasons, rounded amounts), never titles, companies or text; the comparison prints counts, plus the
 * value changes of fields whose values are codes (country, level, reason).
 */
import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db";
import { LEGACY_BASE_CURRENCY } from "@/lib/domain/types";

/** Fields compared; the ones in `CODE_FIELDS` also list their value changes. */
export const REGRESS_FIELDS = [
  "countries",
  "cities",
  "workplace",
  "contract",
  "seniority",
  "language",
  "localLevel",
  "agency",
  "salaryBase",
  "filter",
  "filterReasons",
  "languagePenalty",
  "scoreLevel",
  "signals",
  "t1Base",
] as const;
export type RegressField = (typeof REGRESS_FIELDS)[number];
const CODE_FIELDS: ReadonlySet<RegressField> = new Set(["countries", "workplace", "contract", "seniority", "language", "localLevel", "agency", "filter", "filterReasons", "languagePenalty", "scoreLevel", "signals"]);

export type JobFacts = Record<RegressField, string>;

export interface RegressSnapshot {
  version: 1;
  takenAt: string;
  jobs: Record<string, JobFacts>;
}

const listText = (values: readonly unknown[]): string => [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))].sort().join(",");

/** An annual amount in whole thousands with its currency (`85k EUR`), "" when there is none. */
function amountText(perYear: unknown, currency: unknown): string {
  const n = typeof perYear === "number" ? perYear : typeof perYear === "string" ? Number(perYear) : NaN;
  if (!Number.isFinite(n)) return "";
  return `${Math.round(n / 1000)}k ${typeof currency === "string" ? currency : LEGACY_BASE_CURRENCY}`;
}

type FactRow = Record<string, unknown> & {
  id: string | number;
  locations: unknown;
  workplace: string;
  contract: string;
  seniority: string;
  language: string;
  german_level_required: string;
  is_agency: boolean;
  salary: Record<string, unknown> | null;
  filter_result: string | null;
  filter_reasons: string[] | null;
  german_penalty: number | null;
  german_level: string | null;
  tiers: string[] | null;
  t1: Array<Record<string, unknown>> | null;
};

/** The facts of every job in the database (latest score per job). */
export async function takeRegressSnapshot(db: Db, now = new Date()): Promise<RegressSnapshot> {
  const rows = await db.execute<FactRow>(sql`
    select j.id, j.locations_json as locations, j.workplace, j.contract, j.seniority, j.language, j.german_level_required, j.is_agency,
           j.salary_json as salary, s.filter_result, s.filter_reasons, s.german_penalty, s.german_level,
           (select array_agg(g.tier::text order by g.tier) from signals g where g.job_id = j.id) as tiers,
           (select jsonb_agg(g.value_json order by g.id) from signals g where g.job_id = j.id and g.tier = 'T1') as t1
      from jobs j
      left join lateral (select * from scores x where x.job_id = j.id order by x.id desc limit 1) s on true
  `);
  const jobs: Record<string, JobFacts> = {};
  for (const row of rows) {
    const locations = Array.isArray(row.locations) ? (row.locations as Array<Record<string, unknown>>) : [];
    const salary = row.salary ?? {};
    jobs[String(row.id)] = {
      countries: listText(locations.map((l) => l.countryCode)),
      cities: listText(locations.map((l) => l.city)),
      workplace: row.workplace,
      contract: row.contract,
      seniority: row.seniority,
      language: row.language,
      localLevel: row.german_level_required,
      agency: String(row.is_agency),
      salaryBase: amountText(salary.basePerYear ?? salary.eurPerYear, salary.baseCurrency),
      filter: row.filter_result ?? "",
      filterReasons: listText(row.filter_reasons ?? []),
      languagePenalty: row.german_penalty === null ? "" : String(row.german_penalty),
      scoreLevel: row.german_level ?? "",
      signals: (row.tiers ?? []).join(","),
      t1Base: (row.t1 ?? []).map((v) => amountText(v?.basePerYear ?? v?.eurPerYear, v?.baseCurrency)).join(","),
    };
  }
  return { version: 1, takenAt: now.toISOString(), jobs };
}

export interface FieldDiff {
  changed: number;
  /** Code fields only: `from -> to` with how many jobs, most frequent first. */
  transitions: Array<{ from: string; to: string; count: number }>;
}

export interface RegressComparison {
  base: number;
  head: number;
  both: number;
  onlyBase: number;
  onlyHead: number;
  /** Jobs with at least one changed field. */
  changedJobs: number;
  fields: Record<RegressField, FieldDiff>;
}

/** Compare two snapshots job by job (jobs in only one of them are counted, not compared). */
export function compareRegressSnapshots(base: RegressSnapshot, head: RegressSnapshot, maxTransitions = 10): RegressComparison {
  const fields = Object.fromEntries(REGRESS_FIELDS.map((f) => [f, { changed: 0, transitions: [] }])) as unknown as Record<RegressField, FieldDiff>;
  const counts = new Map<RegressField, Map<string, { from: string; to: string; count: number }>>();
  let both = 0;
  let changedJobs = 0;
  for (const [id, before] of Object.entries(base.jobs)) {
    const after = head.jobs[id];
    if (after === undefined) continue;
    both += 1;
    let changed = false;
    for (const field of REGRESS_FIELDS) {
      const from = before[field] ?? "";
      const to = after[field] ?? "";
      if (from === to) continue;
      changed = true;
      fields[field].changed += 1;
      if (!CODE_FIELDS.has(field)) continue;
      const byPair = counts.get(field) ?? new Map();
      counts.set(field, byPair);
      const key = `${from}\u0000${to}`;
      const entry = byPair.get(key) ?? { from, to, count: 0 };
      entry.count += 1;
      byPair.set(key, entry);
    }
    if (changed) changedJobs += 1;
  }
  for (const [field, byPair] of counts) {
    fields[field].transitions = [...byPair.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).slice(0, maxTransitions);
  }
  const baseCount = Object.keys(base.jobs).length;
  const headCount = Object.keys(head.jobs).length;
  return { base: baseCount, head: headCount, both, onlyBase: baseCount - both, onlyHead: headCount - both, changedJobs, fields };
}

/** The comparison as lines of text (counts and code values only). */
export function renderRegressComparison(c: RegressComparison): string[] {
  const lines = [`jobs: base ${c.base}, head ${c.head}, in both ${c.both} (only base ${c.onlyBase}, only head ${c.onlyHead})`, `jobs with a change: ${c.changedJobs}`];
  for (const field of REGRESS_FIELDS) {
    const diff = c.fields[field];
    lines.push(`  ${field.padEnd(16)} ${diff.changed}`);
    for (const t of diff.transitions) lines.push(`      ${t.from || "∅"} -> ${t.to || "∅"}: ${t.count}`);
  }
  return lines;
}
