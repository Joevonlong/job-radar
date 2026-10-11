import { Star } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/** The read-only small star of a starred job (list rows, board cards): yellow fill, ink outline, read as "starred" by a screen reader. */
export function FavoriteMark({ className }: { className?: string }) {
  const t = useTranslations("favorites");
  return (
    <span data-slot="fav-mark" className={cn("inline-flex shrink-0 items-center", className)} title={t("mark")}>
      <Star aria-hidden className="fill-hi stroke-ink size-3.5" />
      <span className="sr-only">{t("mark")}</span>
    </span>
  );
}
