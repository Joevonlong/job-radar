import { useTranslations } from "next-intl";

import type { VisaKind } from "@/lib/visa/types";
import { cn } from "@/lib/utils";

export type VisaBadgeValue = { status: "offered" | "not_offered"; kind: VisaKind };

/**
 * What the JD says about visa sponsorship, on a job row (only for a user who needs it, or ui.yaml `badges: always`): green
 * "Visa support" when it mentions support, red outline "No visa sponsorship" / "Work permit required" when it refuses. An
 * unclear or silent JD has no badge. Read by rules: the tooltip says to check the quote on the job's page.
 */
export function VisaBadge({ visa, className }: { visa: VisaBadgeValue; className?: string }) {
  const t = useTranslations("visa");
  const key = visa.status === "offered" ? "offered" : visa.kind === "permit_required" ? "permit_required" : "no_sponsorship";
  const title = t(`badgeTitle.${key}`);
  return (
    <span
      data-slot="visa-badge"
      data-testid="visa-badge"
      data-status={visa.status}
      data-kind={visa.kind ?? undefined}
      title={title}
      aria-label={title}
      className={cn(
        "border-bw bg-card rounded-tag text-body-sm inline-block max-w-full overflow-hidden px-2 font-bold text-ellipsis whitespace-nowrap",
        visa.status === "offered" ? "border-good text-good" : "border-bad text-bad border-dashed",
        className,
      )}
    >
      {t(`badge.${key}`)}
    </span>
  );
}
