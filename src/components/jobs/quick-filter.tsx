"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { FilterChip } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const OFF_CLASS =
  "inline-flex h-7 items-center rounded-tag border-bw border-border bg-card px-sp-3 text-body-sm font-medium text-ink-2 transition-colors duration-fast hover:bg-soft hover:text-ink focus-visible:outline-offset-2";

export interface QuickFilterProps {
  /** On: the filter is applied; the chip is yellow with a × that lifts it. */
  active: boolean;
  /** The URL with the filter flipped (the state lives in the URL, so a reload keeps it). */
  href: string;
  /** Text while the filter is off: what pressing does ("Hide German-required"). */
  offLabel: string;
  /** Text while it is on: what is applied ("Hide German-required ×"). */
  onLabel: string;
  /** What the × does, for assistive technology ("Show German-required"). */
  removeLabel: string;
  testId: string;
  title?: string;
  className?: string;
}

/**
 * A quick filter of the list pages: a plain chip when off, a yellow `FilterChip` with × when on. Both are one click on a link to the flipped URL
 * (`replace`, so the browser's back button is not filled with toggles).
 */
export function QuickFilter({ active, href, offLabel, onLabel, removeLabel, testId, title, className }: QuickFilterProps) {
  const router = useRouter();
  const t = useTranslations("dashboard.list");
  if (!active) {
    return (
      <Link href={href} replace className={cn(OFF_CLASS, className)} data-testid={testId} data-active="false" {...(title ? { title } : {})}>
        {offLabel}
      </Link>
    );
  }
  return (
    <FilterChip removeLabel={removeLabel} onRemove={() => router.replace(href)} className={className} data-active="true">
      <Link href={href} replace className="font-bold focus-visible:underline" data-testid={testId} data-active="true" aria-current="true" aria-label={removeLabel} {...(title ? { title } : {})}>
        {onLabel}
      </Link>
      <span className="sr-only">{t("filterOn")}</span>
    </FilterChip>
  );
}
