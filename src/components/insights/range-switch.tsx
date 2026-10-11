"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { insightsHref } from "@/lib/insights/links";

/**
 * 7 / 30 / 90 days as a Segmented control. The range lives in the URL (`?range=`), so a reload or a shared link keeps it:
 * picking one replaces the URL, the server renders the new numbers and the page below rolls them from the old values
 * (the client components keep their place in the tree) while its charts replay.
 */
export function RangeSwitch({ ranges, active, defaultRange }: { ranges: readonly number[]; active: number; defaultRange: number }) {
  const t = useTranslations("insights.range");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(active);
  return (
    <Segmented
      aria-label={t("label")}
      value={String(shown)}
      onValueChange={(value) => {
        const days = Number(value);
        startTransition(() => {
          setShown(days);
          router.replace(insightsHref(days, defaultRange), { scroll: false });
        });
      }}
      data-testid="range-switch"
      data-pending={pending ? "true" : "false"}
    >
      {ranges.map((days) => (
        <SegmentedItem key={days} value={String(days)} data-range={days} data-active={days === shown}>
          {t("days", { count: days })}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}
