import Link from "next/link";
import { useTranslations } from "next-intl";

import { jobsListHref } from "@/lib/jobs/search-params";

/** Relists do not join Today's new-job list; this link keeps its three visibility switches. */
export function RelistedNote({ count, filtered, hideLang, high }: { count: number; filtered: boolean; hideLang: boolean; high: boolean }) {
  const t = useTranslations("dashboard.relisted");
  if (count <= 0) return null;
  return (
    <span className="text-ink-2 text-body-sm" data-testid="relisted-note" data-count={count}>
      <Link href={jobsListHref({ scope: "current", relisted: true, filtered, hideLang, high })} className="text-foreground font-medium underline underline-offset-2" data-testid="relisted-note-link" title={t("hint")}>
        {t("todayNote", { count })}
      </Link>
    </span>
  );
}
