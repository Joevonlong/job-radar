import { UserRoundPen } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

import type { ProfileScoringField } from "@/lib/scoring/profile";
import { INK_LINK } from "@/components/ui/ink-link";
import { cn } from "@/lib/utils";

interface ProfileIncompleteBannerProps {
  /** The me.yaml fields scoring needs at least one of; nothing is shown when empty. */
  missing: readonly ProfileScoringField[];
  /** Jobs waiting for a first score; null when unknown (no database). */
  waiting?: number | null;
  /** Show the link to /me (not on /me itself). */
  showLink?: boolean;
}

/**
 * AI scoring does not run while me.yaml has neither a summary nor skills. Today and /me say so
 * (with the fields to fill in) instead of leaving every job at "waiting for AI score".
 */
export function ProfileIncompleteBanner({ missing, waiting = null, showLink = true }: ProfileIncompleteBannerProps) {
  const t = useTranslations("profile.incomplete");
  if (missing.length === 0) return null;
  const fields = missing.map((field) => t(`fields.${field}`)).join(t("separator"));
  return (
    <div
      role="alert"
      data-testid="profile-incomplete-banner"
      className="border-warning/40 bg-warning/10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-sm"
    >
      <UserRoundPen aria-hidden className="text-warning-text size-4 shrink-0" />
      <span className="font-medium">{t("title")}</span>
      <span className="text-muted-foreground">
        {t("hint", { fields })}
        {waiting !== null && waiting > 0 ? ` ${t("waiting", { count: waiting })}` : ""}
      </span>
      {showLink ? (
        <Link href="/me" className={cn(INK_LINK, "ml-auto inline-flex min-h-sp-6 items-center")} data-testid="profile-incomplete-link">
          {t("link")}
        </Link>
      ) : null}
    </div>
  );
}
