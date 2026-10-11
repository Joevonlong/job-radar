"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { markAllSeenAction, undoMarkAllSeenAction } from "@/app/visit-actions";
import { Button } from "@/components/ui/button";
import { toastTone, toastUndo } from "@/lib/toast";

/** What "mark all seen" covers: /jobs = every page of the list its URL selects; Today = the jobs of the view on screen. */
export type MarkSeenTarget = { scope: "jobs"; query: string; renderedAt: string } | { scope: "list"; jobIds: number[] };

/**
 * "N unseen · Mark all as seen" next to the result count. `count` is the number of unseen jobs the action covers (on /jobs
 * every page of the filtered list, not just this page). The toast after it offers an undo that takes back only this batch.
 */
export function MarkSeenButton({ count, target }: { count: number; target: MarkSeenTarget }) {
  const t = useTranslations("dashboard.seen");
  const tToast = useTranslations("dashboard.toast");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (count === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="unseen-count" data-count={count}>
      <span className="text-foreground inline-flex items-center gap-1.5 text-[13px] font-medium">
        <span aria-hidden className="bg-primary size-2 rounded-full" />
        {t("unseenCount", { count })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        data-testid="mark-all-seen"
        onClick={() => {
          startTransition(async () => {
            const result = await markAllSeenAction(target);
            if (!result.ok) {
              toastTone("error", t("markFailed"));
              return;
            }
            router.refresh();
            toastUndo(
              t("markedToast", { count: result.count }),
              async () => {
                const undone = await undoMarkAllSeenAction({ at: result.at });
                if (undone.ok) router.refresh();
                else toastTone("error", t("markFailed"));
              },
              { tone: "success", label: tToast("undo") },
            );
          });
        }}
      >
        <Check aria-hidden /> {t("markAll")}
      </Button>
    </span>
  );
}
