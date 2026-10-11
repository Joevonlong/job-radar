/** `sources.registry`: one file, its mirror, and the sources that are failing. */
import { reasonsText, registryText, statusLabel } from "@/lib/sources/registry/cli";
import { REGISTRY_STATUSES } from "@/lib/sources/registry/status";

import { fail, joinList, merge, ok, type Piece } from "../helpers";
import { dbUp } from "../shared";
import { SkipCheck, type DoctorCheck } from "../types";

const spec = { id: "sources.registry", group: "channels" } as const;
const MAX_LISTED = 10;

export const sourcesRegistryCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    const { t } = ctx;
    if (!(await dbUp(ctx))) throw new SkipCheck(t("common.dbDown"));
    const page = await ctx.probes.registry();
    if (page.file.invalid !== null) {
      const first = page.file.invalid.slice(0, 3).map((issue) => `${issue.path === "" ? t("checks.sources.registry.fileRoot") : issue.path}: ${issue.message}`);
      return fail(spec, t("checks.sources.registry.invalid", { issues: first.join(t("common.detailSeparator")) }), t("checks.sources.registry.invalidHint", { file: page.file.label }));
    }
    const words = registryText(ctx.locale);
    const pieces: Piece[] = [];
    if (!page.mirror.inSync) pieces.push({ status: "warn", detail: t("checks.sources.registry.mirrorOut"), hint: t("checks.sources.registry.mirrorOutHint") });
    const failing = [...page.view.channels, ...page.view.boards].filter((row) => row.enabled && row.status === "failing");
    if (failing.length > 0) {
      const listed = joinList(
        ctx,
        failing.slice(0, MAX_LISTED).map((row) => t("checks.sources.registry.item", { id: row.id, reason: reasonsText(row.reasons, ctx.config.schedule.timezone, words).split(" · ")[0] ?? "" })),
      );
      const values = { count: failing.length, list: listed };
      pieces.push({ status: "warn", detail: failing.length > MAX_LISTED ? t("checks.sources.registry.failingMore", values) : t("checks.sources.registry.failing", values), hint: t("checks.sources.registry.failingHint") });
    }
    const counts = REGISTRY_STATUSES.map((s) => `${statusLabel(s, words)} ${page.view.counts[s]}`).join(" · ");
    const summary = t("checks.sources.registry.summary", { total: page.view.total, counts });
    if (pieces.length === 0) return ok(spec, summary);
    return merge(ctx, spec, [...pieces, { status: "ok", detail: summary }]);
  },
};

export const SOURCES_CHECKS: readonly DoctorCheck[] = [sourcesRegistryCheck];
