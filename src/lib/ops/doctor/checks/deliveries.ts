import { ok, warn } from "../helpers";
import { SkipCheck, type DoctorCheck } from "../types";

const spec = { id: "data.deliveries", group: "data" } as const;

export const deliveryCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    let probe;
    try {
      probe = await ctx.probes.deliveries();
    } catch {
      throw new SkipCheck(ctx.t("common.dbUnreadable"));
    }
    if (probe.state === "config_error") return warn(spec, ctx.t("checks.data.deliveries.configError", { problem: probe.problem }), ctx.t("checks.data.deliveries.configHint"));
    if (probe.bytes === null) return ok(spec, ctx.t("checks.data.deliveries.notReady"));
    const detail = ctx.t("checks.data.deliveries.bytes", { bytes: probe.bytes, limit: probe.warnBytes });
    return probe.bytes > probe.warnBytes ? warn(spec, detail, ctx.t("checks.data.deliveries.hint")) : ok(spec, detail);
  },
};
