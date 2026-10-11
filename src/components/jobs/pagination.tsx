import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { cn } from "@/lib/utils";

interface PaginationProps {
  page: number;
  pageCount: number;
  /** Builds the URL of a page, keeping the other URL state. */
  hrefFor: (page: number) => string;
}

const itemClass =
  "inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors";

/** Previous / next with the current position. Plain links: paging works without client JS. */
export async function Pagination({ page, pageCount, hrefFor }: PaginationProps) {
  const t = await getTranslations("dashboard.jobs.pagination");
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={t("label")} className="mt-4 flex items-center justify-between gap-3" data-testid="pagination">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={cn(itemClass, "hover:bg-muted")}>
          <ChevronLeft className="size-4" aria-hidden /> {t("previous")}
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(itemClass, "text-muted-foreground opacity-50")}>
          <ChevronLeft className="size-4" aria-hidden /> {t("previous")}
        </span>
      )}
      <span className="text-muted-foreground text-sm tabular-nums" aria-current="page">
        {t("position", { page, pageCount })}
      </span>
      {page < pageCount ? (
        <Link href={hrefFor(page + 1)} rel="next" className={cn(itemClass, "hover:bg-muted")}>
          {t("next")} <ChevronRight className="size-4" aria-hidden />
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(itemClass, "text-muted-foreground opacity-50")}>
          {t("next")} <ChevronRight className="size-4" aria-hidden />
        </span>
      )}
    </nav>
  );
}
