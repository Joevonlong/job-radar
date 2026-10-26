"use client";

import { useFormatter, useTranslations } from "next-intl";

import { useAppLocale } from "@/components/viz/intl";
import { formatFullTime, formatRelativeTime } from "@/lib/format/time";
import type { RegistryReason } from "@/lib/sources/registry/status";

const ERROR_CODES = ["rate_limited", "blocked", "auth_expired", "budget_exceeded", "network", "parse", "not_found", "unknown"] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

const isErrorCode = (code: string): code is ErrorCode => (ERROR_CODES as readonly string[]).includes(code);

/** The words of the registry page: error codes, reasons, times. One place, so the table, the cards and the details agree. */
export function useRegistryText(timeZone: string) {
  const t = useTranslations("sourcesRegistry");
  const format = useFormatter();
  const locale = useAppLocale();

  const errorLabel = (code: string): string => t(`errorCode.${isErrorCode(code) ? code : "unknown"}`);
  const when = (iso: string): string => format.dateTime(new Date(iso), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });

  const reason = (item: RegistryReason): string => {
    const v = item.values ?? {};
    switch (item.key) {
      case "offChannel":
        return t("reason.offChannel");
      case "otherMarket":
        return t("reason.otherMarket", { markets: String(v.markets ?? "") });
      case "offBoard":
        return t("reason.offBoard");
      case "parentOff":
        return t("reason.parentOff", { channel: String(v.channel ?? "") });
      case "noRuns":
        return t("reason.noRuns");
      case "notRegistered":
        return t("reason.notRegistered");
      case "lastRunFailed":
        return t("reason.lastRunFailed", { error: errorLabel(String(v.error ?? "unknown")) });
      case "consecutive":
        return t("reason.consecutive", { count: Number(v.count ?? 0) });
      case "circuitUntil":
        return t("reason.circuitUntil", { when: item.at ? when(item.at) : "—" });
      case "halfOpen":
        return t("reason.halfOpen");
      case "requestFailures":
        return t("reason.requestFailures");
      case "skipped":
        return t("reason.skipped", { count: Number(v.count ?? 0), error: errorLabel(String(v.error ?? "unknown")) });
      case "cascadeStandby":
        return t("reason.cascadeStandby");
      case "missingEnv":
        return t("reason.missingEnv", { names: String(v.names ?? "") });
      case "loginMissing":
        return t("reason.loginMissing");
      case "loginExpired":
        return t("reason.loginExpired");
      case "missingApify":
        return t("reason.missingApify");
      case "missingMonid":
        return t("reason.missingMonid");
      case "notConfigured":
        return t("reason.notConfigured");
      case "neverChecked":
        return t("reason.neverChecked");
      case "boardFailing":
        return t("reason.boardFailing", { count: Number(v.count ?? 0), error: errorLabel(String(v.error ?? "unknown")) });
      case "boardFailedOnce":
        return t("reason.boardFailedOnce", { error: errorLabel(String(v.error ?? "unknown")) });
      case "boardStale":
        return t("reason.boardStale", { hours: Number(v.hours ?? 0) });
    }
  };

  return {
    errorLabel,
    reason,
    reasons: (items: readonly RegistryReason[]): string => (items.length === 0 ? "—" : items.map(reason).join(" · ")),
    when,
    relative: (iso: string | null, now: Date): string => formatRelativeTime(iso, now, { locale, timeZone }),
    full: (iso: string | null): string => formatFullTime(iso, { locale, timeZone }),
  };
}
