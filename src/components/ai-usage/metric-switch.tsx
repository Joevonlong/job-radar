"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { AI_USAGE_METRICS, aiUsageHref, type AiUsageMetric, type AiUsageUrlState } from "@/lib/ai-usage/params";

/** Token / equivalent cost / calls for the daily chart; the choice is the `metric` of the URL. */
export function MetricSwitch({ state, active }: { state: AiUsageUrlState; active: AiUsageMetric }) {
  const t = useTranslations("aiUsage.daily.metric");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(active);
  return (
    <Segmented
      aria-label={t("label")}
      value={shown}
      onValueChange={(value) => {
        const metric = AI_USAGE_METRICS.find((m) => m === value);
        if (!metric) return;
        startTransition(() => {
          setShown(metric);
          router.replace(aiUsageHref(state, { metric }), { scroll: false });
        });
      }}
      data-testid="ai-usage-metric"
      data-pending={pending ? "true" : "false"}
    >
      {AI_USAGE_METRICS.map((metric) => (
        <SegmentedItem key={metric} value={metric} data-metric={metric}>
          {t(metric)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}
