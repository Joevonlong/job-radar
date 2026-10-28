"use client";

import { Ellipsis } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { markUnseenAction as rawMarkUnseenAction } from "@/app/visit-actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { noteSeenLocally } from "@/lib/dashboard/seen-local";
import { toastTone } from "@/lib/toast";

import { useFilterOverride, type OverrideAction } from "../filter-override-button";
import { withActionFeedback } from "@/lib/actions/client";

const markUnseenAction = withActionFeedback(rawMarkUnseenAction)(() => ({ ok: false }));

/**
 * The "more" menu at the end of the header's action row: the optional filter decision of a job that passed ("过滤这条") lives here
 * instead of in a fifth button, which did not fit the row next to the four main actions at 1440px and wrapped to a second line.
 * It is two clicks away, with the same wording and toast as the button of the filter notice. (The page shows "仍然保留" / "改回按规则判断"
 * as buttons: they rescue a job the filter removed or undo a decision.) "Mark as unseen" is always here (the job is bold in the
 * lists again until it is opened again).
 */
export function MoreActions({ jobId, overrideAction }: { jobId: number; overrideAction: OverrideAction | null }) {
  const t = useTranslations("dashboard.detail.actions");
  const tOverride = useTranslations("filter.override");
  const tSeen = useTranslations("dashboard.seen");
  const { pending, run } = useFilterOverride(jobId);
  const [seenPending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={t("more")} title={t("more")} data-testid="action-more">
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {overrideAction ? (
          <DropdownMenuItem disabled={pending} data-testid={`filter-override-${overrideAction}`} onSelect={() => run(overrideAction)}>
            {tOverride(overrideAction)}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          disabled={seenPending}
          data-testid="action-mark-unseen"
          onSelect={() => {
            startTransition(async () => {
              const result = await markUnseenAction({ jobId });
              if (!result.ok) {
                toastTone("error", tSeen("markFailed"));
                return;
              }
              noteSeenLocally(jobId, false);
              toastTone("success", tSeen("markedUnseen"));
            });
          }}
        >
          {tSeen("markUnseen")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
