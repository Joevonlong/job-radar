import { fail, ok, warn } from "../helpers";
import { SkipCheck, type DoctorCheck } from "../types";
const spec = { id: "data.current_scores", group: "data" } as const;
export const currentScoresCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    let health;
    try { health = await ctx.probes.currentScores(); } catch { throw new SkipCheck(ctx.t("common.dbUnreadable")); }
    if (!health.present) return warn(spec, ctx.t("checks.data.current_scores.missing"), ctx.t("checks.data.current_scores.migrate"));
    const detail = ctx.t("checks.data.current_scores.detail", { rows: health.rows, at: health.checkedAt ?? ctx.t("checks.data.current_scores.never"), differences: health.differences ?? 0 });
    if ((health.remaining ?? 0) > 0) return fail(spec, detail, ctx.t("checks.data.current_scores.repair"));
    return ok(spec, detail);
  },
};
