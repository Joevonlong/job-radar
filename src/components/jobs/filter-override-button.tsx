"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { setFilterOverrideAction } from "@/app/jobs/[id]/filter-actions";
import { Button } from "@/components/ui/button";

export type OverrideAction = "keep" | "exclude" | "clear";

/** Saves the user's filter decision for a job (keep / exclude / take back) with the toast of the result; `pending` while it runs. */
export function useFilterOverride(jobId: number) {
  const t = useTranslations("filter.override");
  const [pending, start] = useTransition();
  const run = (action: OverrideAction) =>
    start(async () => {
      const result = await setFilterOverrideAction({ jobId, action });
      if (result.ok) toast.success(t("saved"));
      else toast.error(t("error"));
    });
  return { pending, run };
}

/** The small button of the filter notice: keep a filtered job, exclude a passed one, or take the decision back. */
export function FilterOverrideButton({ jobId, action, size = "xs" }: { jobId: number; action: OverrideAction; size?: "xs" | "md" }) {
  const t = useTranslations("filter.override");
  const { pending, run } = useFilterOverride(jobId);
  return (
    <Button type="button" variant="outline" size={size} disabled={pending} data-testid={`filter-override-${action}`} onClick={() => run(action)}>
      {t(action)}
    </Button>
  );
}
