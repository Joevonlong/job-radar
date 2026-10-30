import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { resolveLocale } from "@/i18n/locale";
import { activityLabel } from "@/lib/activity/messages";
import type { ActivityEventRow } from "@/lib/db/queries/activity";
import { formatInteger } from "@/lib/format/numbers";
import { link } from "./shared";

/** Strings are rendered only through closed message catalogs; unknown parameter names/values never appear. */
export function EventParams({ event }: { event: Pick<ActivityEventRow, "code" | "params"> }) {
  const t = useTranslations("activityLog");
  const locale = resolveLocale(useLocale());
  if (event.code === "parse_failed") return <span>{t("rawParseFailed")}</span>;
  return <ul className="grid gap-sp-1" data-testid="activity-log-event-params">{Object.entries(event.params).map(([key, value]) => {
    if (event.code === "covered_by" && key === "cycle_id" && typeof value === "number" && Number.isSafeInteger(value) && value > 0) return <li key={key}><Link className={link} href={`/sources/logs?cycle=${value}`}>{t("coveredBy", { id: formatInteger(value, locale) })}</Link></li>;
    if (event.code === "cascade_reasons") return <li key={key}>{key}: {activityLabel(t, "reason", typeof value === "string" ? value : "other")}</li>;
    if (key === "error_code") return <li key={key}>{activityLabel(t, "error", typeof value === "string" ? value : "other")}</li>;
    if (key === "action") return <li key={key}>{t("params.action")}: {activityLabel(t, "callbackAction", typeof value === "string" ? value : null)}</li>;
    if (key === "result") return <li key={key}>{t("params.result")}: {activityLabel(t, "callbackResult", typeof value === "string" ? value : null)}</li>;
    if (typeof value === "number") return <li key={key}>{t.has(`params.${key}` as never) ? t(`params.${key}` as never) : t("params.count")}: {formatInteger(value, locale)}</li>;
    if (typeof value === "boolean") return <li key={key}>{t("params.flag")}: {t(value ? "yes" : "no")}</li>;
    return null;
  })}</ul>;
}
