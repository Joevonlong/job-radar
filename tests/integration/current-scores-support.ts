import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { Executor } from "@/lib/db/executor";
import { companies, jobs, scores } from "@/lib/db/schema";
import { checkCurrentScores, CURRENT_SCORE_COLUMNS } from "@/lib/db/repos/current-scores";
import { latestScoreCte } from "@/lib/db/queries/job-cards";
export async function fixture(db: Executor, count = 1) {
  const [company] = await db.insert(companies).values({ name: "Projection Fixtures", nameNorm: "projection fixtures" }).returning();
  return db.insert(jobs).values(Array.from({ length: count }, (_, i) => ({ companyId: company!.id, title: `Role ${i}`, titleNorm: `role ${i}` }))).returning();
}
/** Independent SQL comparison bypasses checkCurrentScores and the refresh query's composition. */
export async function expectNoDrift(db: Executor) {
  expect(await checkCurrentScores(db)).toEqual([]);
  const latest = latestScoreCte(db, undefined, true);
  const columns = sql.join(CURRENT_SCORE_COLUMNS.map((name) => sql.identifier(name)), sql`, `);
  const rows = await db.execute(sql`with expected as (${db.with(latest).select().from(latest)}), diff as (
    (select ${columns} from expected except all select ${columns} from job_current_scores)
    union all (select ${columns} from job_current_scores except all select ${columns} from expected)
  ) select * from diff`);
  expect(Array.from(rows)).toEqual([]);
}
export const scoreRow = (jobId: number, score: number | null = 70) => ({ jobId, filterResult: "passed" as const, score, rankValue: score, signalBonus: 0, summaries: { en: "Summary" }, outputLang: "en" });
export { scores };
export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
