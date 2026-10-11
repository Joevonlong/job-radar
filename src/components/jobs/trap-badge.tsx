import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * "AI trap" (×N) on a job row: the posting holds content written to mislead an AI. A solid `--bad` block with the ink
 * border, before every other badge; the tooltip says how many and where to look. Only for severity `trap`.
 */
export function TrapBadge({ count, className }: { count: number; className?: string }) {
  const t = useTranslations("aiTraps");
  const title = t("badgeTitle", { count });
  return (
    <span
      data-slot="trap-badge"
      data-testid="trap-badge"
      data-count={count}
      title={title}
      aria-label={title}
      className={cn("border-bw border-ink bg-bad text-on-bad rounded-tag text-body-sm inline-block max-w-full overflow-hidden px-2 font-bold text-ellipsis whitespace-nowrap", className)}
    >
      {t("badge", { count })}
    </span>
  );
}
