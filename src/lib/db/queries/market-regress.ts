import { sql } from "drizzle-orm";

import type { Db } from "../client";

export type FactRow = Record<string, unknown> & {
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

/** All job facts, with the latest score per job and ordered signal values. */
export async function listRegressFactRows(db: Db): Promise<FactRow[]> {
  return db.execute<FactRow>(sql`
    select j.id, j.locations_json as locations, j.workplace, j.contract, j.seniority, j.language, j.german_level_required, j.is_agency,
           j.salary_json as salary, s.filter_result, s.filter_reasons, s.german_penalty, s.german_level,
           (select array_agg(g.tier::text order by g.tier) from signals g where g.job_id = j.id) as tiers,
           (select jsonb_agg(g.value_json order by g.id) from signals g where g.job_id = j.id and g.tier = 'T1') as t1
      from jobs j
      left join lateral (select * from scores x where x.job_id = j.id order by x.id desc limit 1) s on true
  `);
}
