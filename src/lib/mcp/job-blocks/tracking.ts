import type { z } from "zod";

import type { JobDetail } from "@/lib/db/queries/job-detail";
import { getLatestAppliedDates } from "@/lib/db/repos/applications";
import { getFilterOverrides } from "@/lib/db/repos/filter-overrides";
import { getSeenJobIds } from "@/lib/db/repos/seen";
import type { McpContext } from "@/lib/mcp/context";
import { trackingBlockDto } from "@/lib/mcp/dto/job-tracking";
import { isoOrNull, type CleanText } from "@/lib/mcp/dto/shared";

import type { JobBlockSource } from "./source";

type TrackingBlock = z.infer<typeof trackingBlockDto>;

export async function loadTracking(ctx: McpContext, { detail, clean }: Pick<JobBlockSource, "detail" | "clean">): Promise<TrackingBlock> {
  return (await loadTrackingByJob(ctx, [detail], clean)).get(detail.id)!;
}

export async function loadTrackingByJob(ctx: McpContext, details: readonly JobDetail[], clean: CleanText): Promise<Map<number, TrackingBlock>> {
  const states = details.map((detail) => ({ detail, recentApplied: detail.applicationEvents.find((event) => event.toStatus === "applied") }));
  const jobIds = details.map(({ id }) => id);
  const olderAppliedIds = states.flatMap(({ detail, recentApplied }) => detail.application && !recentApplied ? [detail.application.id] : []);
  const [seen, overrides, olderApplied] = await Promise.all([
    getSeenJobIds(ctx.db, jobIds),
    getFilterOverrides(ctx.db, jobIds),
    getLatestAppliedDates(ctx.db, olderAppliedIds),
  ]);
  return new Map(states.map(({ detail, recentApplied }) => {
    const appliedAt = recentApplied
      ? recentApplied.occurredAt ?? recentApplied.at
      : detail.application && olderApplied.get(detail.application.id);
    return [detail.id, toTrackingBlock(detail, clean, seen.has(detail.id), overrides.get(detail.id) ?? null, appliedAt ?? null)];
  }));
}

function toTrackingBlock(detail: JobDetail, clean: CleanText, seen: boolean, override: TrackingBlock["filter_override"], appliedAt: Date | null): TrackingBlock {
  const application = detail.application;
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
