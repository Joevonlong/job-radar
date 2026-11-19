import type { z } from "zod";

import { getLatestAppliedAt } from "@/lib/db/repos/applications";
import { getFilterOverride } from "@/lib/db/repos/filter-overrides";
import { isSeen } from "@/lib/db/repos/seen";
import type { McpContext } from "@/lib/mcp/context";
import { trackingBlockDto } from "@/lib/mcp/dto/job-tracking";
import { isoOrNull } from "@/lib/mcp/dto/shared";

import type { JobBlockSource } from "./source";

export async function loadTracking(ctx: McpContext, { detail, clean }: Pick<JobBlockSource, "detail" | "clean">): Promise<z.infer<typeof trackingBlockDto>> {
  const application = detail.application;
  const recentApplied = detail.applicationEvents.find((event) => event.toStatus === "applied");
  const [seen, override, appliedAt] = await Promise.all([
    isSeen(ctx.db, detail.id),
    getFilterOverride(ctx.db, detail.id),
    recentApplied ? recentApplied.occurredAt ?? recentApplied.at : application && getLatestAppliedAt(ctx.db, application.id),
  ]);
  return {
    application: application ? {
      status: application.status,
      status_changed_at: application.statusChangedAt.toISOString(),
      created_at: application.createdAt.toISOString(),
      applied_at: isoOrNull(appliedAt),
      next_action: application.nextAction === null ? null : clean(application.nextAction),
      next_action_at: isoOrNull(application.nextActionAt),
      interview_rounds: application.interviewRounds,
      history: detail.applicationEvents.map((event) => ({
        from: event.fromStatus,
        to: event.toStatus,
        at: event.at.toISOString(),
        occurred_at: isoOrNull(event.occurredAt),
        reference: event.reference === null ? null : clean(event.reference),
      })),
    } : null,
    favorite: detail.favorite ? { since: detail.favorite.createdAt.toISOString() } : null,
    seen,
    closure: { auto_status: detail.closure.autoStatus, reason: detail.closure.reason, override: detail.closure.override ? { action: detail.closure.override.action, at: detail.closure.override.createdAt.toISOString() } : null, link_check: detail.closure.linkCheck ? { outcome: detail.closure.linkCheck.outcome, checked_at: detail.closure.linkCheck.at } : null },
    filter_override: override,
  };
}
