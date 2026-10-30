import { latestScoreCte as frozenLatestScoreCte } from "../integration/current-scores-baseline/job-cards";
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { currentScore, currentScoreFew, currentScoreRead, latestScoreCte, latestScoreLateral, withCurrentScore } from "@/lib/db/queries/job-cards";
import { invalidateCurrentScores } from "@/lib/db/repos/current-scores";
const makeDb = (present: boolean) => {
  const db = drizzle.mock({ schema });
  const execute = vi.spyOn(db, "execute").mockResolvedValue([{ present }] as never);
  return { db, execute };
};
describe("current score source", () => {
  it("uses the projection and caches only presence", async () => {
    const { db, execute } = makeDb(true);
    const latest = await currentScore(db, "set");
    const query = withCurrentScore(db, latest).select({ id: latest.jobId }).from(schema.jobs).leftJoin(latest, sql`true`).toSQL().sql;
    expect(query).toContain('"job_current_scores" "latest_score"');
    expect(query).not.toContain("distinct on");
    await currentScore(db, "set"); expect(execute).toHaveBeenCalledTimes(1);
    invalidateCurrentScores(db);
    await currentScore(db, "set"); expect(execute).toHaveBeenCalledTimes(2);
  });
  it("rechecks absence and uses the legacy set and few shapes", async () => {
    const { db, execute } = makeDb(false);
    const set = await currentScore(db, "set");
    expect(withCurrentScore(db, set).select().from(set).toSQL().sql).toContain("distinct on");
    const few = await currentScoreFew(db);
    const query = db.select().from(schema.jobs).leftJoinLateral(few, sql`true`).toSQL().sql;
    expect(query).toContain('from "scores"'); expect(execute).toHaveBeenCalledTimes(2);
  });
  it("invalidates on missing-table errors and retries only once", async () => {
    const { db, execute } = makeDb(true);
    await currentScore(db, "set");
    const read = vi.fn().mockRejectedValueOnce({ cause: { code: "42P01" } }).mockImplementation(async () => { await currentScore(db, "set"); return 7; });
    expect(await currentScoreRead(db, read)).toBe(7); expect(execute).toHaveBeenCalledTimes(2);
    await expect(currentScoreRead(db, async () => { throw { code: "XX000" }; })).rejects.toEqual({ code: "XX000" });
  });
  it("keeps unscoped SQL identical to explicitly omitted scope and scopes both score scans", () => {
    const { db } = makeDb(false);
    const first = latestScoreCte(db); const second = frozenLatestScoreCte(db);
    expect(db.with(first).select().from(first).toSQL()).toEqual(db.with(second).select().from(second).toSQL());
    const scoped = latestScoreCte(db, [1, 2], true);
    const query = db.with(scoped).select().from(scoped).toSQL();
    expect(query.params).toEqual(["{1,2}", "{1,2}"]);
    const large = latestScoreCte(db, Array.from({ length: 40000 }, (_, i) => i + 1), true);
    expect(db.with(large).select().from(large).toSQL().params).toHaveLength(2);
    const lateral = latestScoreLateral(db, [1, 2], true);
    expect(db.select().from(lateral).toSQL().sql).toContain("unnest");
  });
});
