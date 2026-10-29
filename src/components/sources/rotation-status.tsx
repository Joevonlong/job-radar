import { getLocale, getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/locale";
import { formatInteger } from "@/lib/format/numbers";
import type { RotationStatus } from "@/lib/sources/rotation-status";
import { cn } from "@/lib/utils";

/** Awaited by both server cards so the same line and warning stay together. */
export async function RotationStatusLine({ rotation, cascade = false, backfillId }: { rotation: RotationStatus; cascade?: boolean; backfillId?: string }) {
  const [t, remote, localeId, backfill] = await Promise.all([getTranslations("sources.rotation"), getTranslations("settings.options.remoteScope"), getLocale(), getTranslations("sources.backfill")]);
  const locale = resolveLocale(localeId);
  const number = (value: number) => formatInteger(value, locale);
  const waiting = rotation.oldestWaiting;
  const scope = waiting?.remoteScope;
  const place = waiting?.location ?? (scope === "worldwide" || scope === "home_country" ? remote(scope)
    : scope?.startsWith("region:") ? t("remoteRegion", { scope: scope.slice("region:".length) }) : t("remote"));
  const parts = [t("queries", { count: rotation.queries, number: number(rotation.queries) })];
  if (rotation.sortChannel === null) parts.push(t("unavailable"));
  else {
    if (rotation.oldestWaitHours !== null && waiting) parts.push(t("wait", { hours: number(rotation.oldestWaitHours), group: waiting.keywordGroup, place }));
    if (rotation.neverRun > 0) parts.push(t("neverRun", { count: rotation.neverRun, number: number(rotation.neverRun) }));
    if (cascade) parts.push(t("orderedBy", { channel: rotation.sortChannel }));
  }
  return (
    <div className={cn("min-w-0 text-data [overflow-wrap:anywhere]", rotation.overCap > 0 ? "text-warning-text" : "text-ink-2")}
      data-testid="rotation-status" data-queries={rotation.queries} data-never-run={rotation.neverRun} data-over-cap={rotation.overCap} data-sort-channel={rotation.sortChannel ?? ""}>
      <p>{parts.join(" · ")}</p>
      {rotation.overCap > 0 ? <p className="mt-1" data-testid="rotation-warning">{t("overCap", { count: rotation.overCap, number: number(rotation.overCap), hours: number(rotation.maxCatchUpHours) })}{backfillId ? <> <a href={`#${backfillId}`} className="underline underline-offset-4 focus-visible:outline-bw">{backfill("gap")}</a></> : null}</p> : null}
    </div>
  );
}
