import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * "12 new since your last visit · newest first" next to the count, when the list is not sorted newest first (that order draws
 * a divider instead). The link switches to that order; without `href` (Today, sorted by score) it is the sentence alone.
 */
export function NewSinceVisitNote({ count, href }: { count: number; href?: string }) {
  const t = useTranslations("dashboard.seen");
  return (
    <span className="text-ink-2 text-body-sm" data-testid="new-since-visit" data-count={count}>
      {t("newSince", { count })}
      {href ? (
        <>
          {" · "}
          <Link href={href} className="text-foreground font-medium underline underline-offset-2" data-testid="new-since-visit-link">
            {t("newestFirst")}
          </Link>
        </>
      ) : null}
    </span>
  );
}
