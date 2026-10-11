/**
 * `setup.completed`: whether the first-run setup is finished. Pending = warn (scheduled cycles wait for it);
 * an unreadable or invalid setup.yaml = fail (the install counts as set up meanwhile, so nothing is locked).
 */
import { fail, ok, warn } from "../helpers";
import type { DoctorCheck } from "../types";

const spec = { id: "setup.completed", group: "data" } as const;

export const setupCompletedCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    const { t } = ctx;
    const status = await ctx.probes.setup();
    if (status.error !== null) return fail(spec, t("checks.setup.completed.invalid", { error: status.error }), t("checks.setup.completed.invalidHint"));
    if (status.pending) return warn(spec, t("checks.setup.completed.pending"), t("checks.setup.completed.pendingHint"));
    if (status.source === "existing_install") return ok(spec, t("checks.setup.completed.existing"));
    if (status.source === "missing" || status.state === null) return warn(spec, t("checks.setup.completed.missing"), t("checks.setup.completed.missingHint"));
    const by = status.state.completed_by;
    return ok(spec, t("checks.setup.completed.ok", { at: status.state.completed_at ?? "", by: by === null ? "" : t(`checks.setup.completed.by.${by}`) }));
  },
};

export const SETUP_CHECKS: readonly DoctorCheck[] = [setupCompletedCheck];
