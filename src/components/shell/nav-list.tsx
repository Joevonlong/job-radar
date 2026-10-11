"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";

import { resolveLocale } from "@/i18n/locale";
import { formatInteger } from "@/lib/format/numbers";
import { cn } from "@/lib/utils";

import { groupNavItems, isNavActive, type NavKey } from "./nav";
import { useSharedShellStatus } from "./shell-status-provider";

interface NavListProps {
  /** Called after a link is activated, e.g. to close the mobile sheet. */
  onNavigate?: () => void;
  /** Count badges by nav key; a missing key shows none. */
  counts?: Partial<Record<NavKey, number>>;
  /** Warning badges by nav key (a count of things that need a look, e.g. failing sources); nothing is drawn for 0. */
  alerts?: Partial<Record<NavKey, number>>;
}

/** The terminal nav (sidebar and drawer): amber inverse for the current page, ">" on hover, the last three under "// settings". */
export function NavList({ onNavigate, counts: countsProp, alerts: alertsProp }: NavListProps) {
  const status = useSharedShellStatus();
  // without props the badges come from the shared shell status; Today's badge is "new today", hidden at 0
  const counts: NavListProps["counts"] =
    countsProp ?? (status ? { ...(status.counts.today > 0 ? { today: status.counts.today } : {}), jobs: status.counts.jobs, favorites: status.counts.favorites, pipeline: status.counts.pipeline } : undefined);
  const alerts: NavListProps["alerts"] = alertsProp ?? (status ? { sources: status.counts.sourcesAlert } : undefined);
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tShell = useTranslations("shell");
  const labelId = useId();
  const locale = resolveLocale(useLocale());

  return (
    <nav aria-label={tShell("mainNavigation")} className="flex flex-col gap-0.5 font-mono text-body-sm">
      {groupNavItems().map(({ group, items }) => (
        <div
          key={group}
          role="group"
          aria-labelledby={group === "settings" ? labelId : undefined}
          className="flex flex-col gap-0.5"
        >
          {group === "settings" ? (
            <span id={labelId} className="px-sp-2 pt-sp-3 pb-sp-1 text-cap tracking-[0.1em] text-term-dim">
              {tShell("groupSettings")}
            </span>
          ) : null}
          {items.map(({ key, href }) => {
            const active = isNavActive(pathname, href);
            const count = counts?.[key];
            const alert = alerts?.[key] ?? 0;
            return (
              <Link
                key={key}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
                className={cn(
                  "nav-caret flex items-center gap-sp-2 rounded-tag px-sp-2 py-1.5 transition-colors duration-fast",
                  active ? "bg-term-amber font-bold text-term-bg" : "text-term-ink hover:bg-term-line",
                )}
              >
                <span className="truncate">{t(key)}</span>
                {alert > 0 ? (
                  <em
                    data-testid={`nav-alert-${key}`}
                    aria-label={tShell("alertLabel", { count: alert })}
                    className={cn("ml-auto text-data-sm font-bold not-italic", active ? "" : "text-term-bad")}
                  >
                    <span aria-hidden>▲ </span>
                    {formatInteger(alert, locale)}
                  </em>
                ) : null}
                {count === undefined ? null : (
                  <em data-testid={`nav-count-${key}`} className={cn("text-data-sm not-italic opacity-75", alert > 0 ? "" : "ml-auto")}>
                    {formatInteger(count, locale)}
                  </em>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
