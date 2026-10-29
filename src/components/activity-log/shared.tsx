import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Led, PercentBar } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { resolveLocale } from "@/i18n/locale";
import type { ActivityRootRow } from "@/lib/db/queries/activity";
import { activityLabel, type ActivityTranslator } from "@/lib/activity/messages";
import type { DisplayStatus } from "@/lib/activity/display-status";
import { activityHref, type ActivityUrlState } from "@/lib/activity/search";
import { formatFraction, formatInteger, ratioPercent } from "@/lib/format/numbers";

export const panel = "min-w-0 rounded-card border-bw border-border bg-card-bg p-sp-4 shadow-e1";
export const field = "h-ctl-md min-w-0 max-w-full rounded-btn border-bw border-border bg-card px-sp-2 text-body-sm";
export const link = "underline decoration-dotted underline-offset-4 [overflow-wrap:anywhere]";
export const cell = "px-sp-3 py-sp-2 text-left align-top";

export function rootName(root: Pick<ActivityRootRow, "scope" | "name" | "cycleId" | "request">, t: ActivityTranslator, cycleId: string): string {
  if (root.scope === "cycle" && root.cycleId !== null) return t("cycle", { id: cycleId });
  if (root.scope === "request" && root.request) return activityLabel(t, "requestKind", root.request.kind);
  return activityLabel(t, "span", root.name);
}

export function StatusBadge({ value }: { value: DisplayStatus }) {
  const t = useTranslations("activityLog");
  const running = ["running", "ai_queued", "ai_running"].includes(value.code);
  const tone = value.code === "ok" ? "good" : ["failed", "interrupted"].includes(value.code) ? "bad" : ["partial", "possibly_interrupted", "requeued"].includes(value.code) ? "warn" : "idle";
  return <span className="inline-flex flex-col gap-sp-1" data-testid="activity-log-status" data-activity-log-status={value.code}>
    <Led tone={tone} live={running} label={activityLabel(t, "status", value.code)} />
    {value.requestCurrent ? <span className="text-data-sm text-ink-2">{t("requestCurrent", { status: activityLabel(t, "requestStatus", value.requestCurrent) })}</span> : null}
  </span>;
}

export function Progress({ name, done, total }: { name?: string; done: number | null; total: number | null }) {
  const t = useTranslations("activityLog");
  const locale = resolveLocale(useLocale());
  if (done === null && total === null) return name ? <span>{activityLabel(t, "span", name)}</span> : null;
  const label = `${name ? `${activityLabel(t, "span", name)} · ` : ""}${done === null || total === null ? t("unknown") : formatFraction(done, total, locale)}`;
  return <div className="grid gap-sp-1" data-testid="activity-log-progress"><PercentBar value={ratioPercent(done, total)} label={label} ariaLabel={label} size="sm" /></div>;
}

export function Dropped({ count }: { count: number }) {
  const t = useTranslations("activityLog");
  const locale = resolveLocale(useLocale());
  return count > 0 ? <span className="text-body-sm font-bold" data-testid="activity-log-dropped">{t("incomplete", { count: formatInteger(count, locale) })}</span> : null;
}

export function Pagination({ state, total, pageSize, base = "/sources/logs" }: { state: ActivityUrlState; total: number; pageSize: number; base?: string }) {
  const t = useTranslations("activityLog");
  const locale = resolveLocale(useLocale());
  return <nav className="flex flex-wrap items-center justify-between gap-sp-3" aria-label={t("pagination")}>
    <span className="font-mono text-data">{t("pageCount", { page: formatInteger(state.page, locale), total: formatInteger(total, locale) })}</span>
    <span className="flex gap-sp-2">
      {state.page > 1 ? <Button asChild size="sm"><Link rel="prev" href={activityHref(state, { page: state.page - 1 }, base)} data-testid="activity-log-prev">{t("prev")}</Link></Button> : null}
      {state.page * pageSize < total ? <Button asChild size="sm"><Link rel="next" href={activityHref(state, { page: state.page + 1 }, base)} data-testid="activity-log-next">{t("next")}</Link></Button> : null}
    </span>
  </nav>;
}
