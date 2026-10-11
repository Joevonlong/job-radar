"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { setGhostDismissAction } from "@/app/jobs/[id]/ghost-actions";
import { Button } from "@/components/ui/button";

/** "Not a ghost job" (dismiss the mark) or "Undo" (take the dismissal back) on the checks card's ghost job row. */
export function GhostDismissButton({ jobId, action }: { jobId: number; action: "dismiss" | "clear" }) {
  const t = useTranslations("ghostJobs.checks");
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const result = await setGhostDismissAction({ jobId, action });
      if (!result.ok) toast.error(t("failed"));
    });
  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} data-testid={action === "dismiss" ? "ghost-dismiss" : "ghost-undo"} onClick={run}>
      {t(action === "dismiss" ? "dismiss" : "undo")}
    </Button>
  );
}
