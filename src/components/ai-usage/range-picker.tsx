"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { aiUsageHref, type AiUsageUrlState } from "@/lib/ai-usage/params";
import { AI_USAGE_RANGE_KINDS, type AiUsageRangeKind } from "@/lib/ai-usage/range";

const LABEL: Record<AiUsageRangeKind, "today" | "d7" | "d30" | "month" | "custom"> = { today: "today", "7d": "d7", "30d": "d30", month: "month", custom: "custom" };

/**
 * Today / 7 days / 30 days / this month / custom as a Segmented control. The range lives in the URL (`?range=`, and
 * `from` / `to` for a custom one), so a reload or a shared link keeps it; the filters stay, the page number resets.
 */
export function RangePicker({ state, active, from, to, today }: { state: AiUsageUrlState; active: AiUsageRangeKind; from: string; to: string; today: string }) {
  const t = useTranslations("aiUsage.range");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(active);
  const [open, setOpen] = useState(active === "custom");
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const go = (patch: Partial<AiUsageUrlState>) =>
    startTransition(() => {
      if (patch.range) setShown(patch.range);
      router.replace(aiUsageHref(state, { ...patch, page: null }), { scroll: false });
    });
  const showCustom = open || shown === "custom";
  const valid = draftFrom !== "" && draftTo !== "" && draftFrom <= draftTo && draftTo <= today;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="ai-usage-range-picker">
      <div className="ai-range-scroll">
        <Segmented
          aria-label={t("label")}
          value={showCustom ? "custom" : shown}
          onValueChange={(value) => {
            const kind = AI_USAGE_RANGE_KINDS.find((k) => k === value);
            if (!kind) return;
            if (kind === "custom") {
              // start from the window the page shows now, not from a made-up one
              setDraftFrom(from);
              setDraftTo(to);
              setOpen(true);
              return;
            }
            setOpen(false);
            go({ range: kind, from: null, to: null });
          }}
          data-testid="ai-usage-range"
          data-pending={pending ? "true" : "false"}
        >
          {AI_USAGE_RANGE_KINDS.map((kind) => (
            <SegmentedItem key={kind} value={kind} data-range={kind} data-active={kind === (showCustom ? "custom" : shown)}>
              {t(LABEL[kind])}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      {showCustom ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"
          data-testid="ai-usage-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) go({ range: "custom", from: draftFrom, to: draftTo });
          }}
        >
          <label className="flex flex-col gap-1 text-label font-bold">
            {t("from")}
            <Input type="date" name="from" value={draftFrom} max={today} onChange={(e) => setDraftFrom(e.target.value)} aria-label={t("from")} data-testid="ai-usage-from" />
          </label>
          <label className="flex flex-col gap-1 text-label font-bold">
            {t("to")}
            <Input type="date" name="to" value={draftTo} max={today} onChange={(e) => setDraftTo(e.target.value)} aria-label={t("to")} data-testid="ai-usage-to" />
          </label>
          <Button type="submit" variant="default" disabled={!valid} data-testid="ai-usage-apply">
            {t("apply")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
