"use client";

import Link from "next/link";
import { useId } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";

/** Offers shortening only when a measured page count exceeds the document's page budget; the page count comes from the caller. */
export function ShrinkButton({ docId, budget, pageCount }: { docId: string; budget: number; pageCount: number | null }) {
  const t = useTranslations("career.tailor");
  const id = useId();
  const over = pageCount === null ? null : pageCount - budget;
  if (over !== null && over > 0) {
    return (
      <Link data-testid="tailor-shrink" href={`/career/tailor?doc=${docId}&mode=shrink&over=${over}`} className={buttonVariants({ variant: "outline" })}>
        {t("shrink")}
      </Link>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <Button data-testid="tailor-shrink" variant="outline" disabled aria-describedby={`${id}-reason`}>{t("shrink")}</Button>
      <span id={`${id}-reason`} className="text-body-sm text-ink-2">{t(over === null ? "shrinkUnknown" : "shrinkWithin")}</span>
    </span>
  );
}
