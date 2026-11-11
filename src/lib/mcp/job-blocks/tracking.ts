import type { z } from "zod";

import { getFilterOverride } from "@/lib/db/repos/filter-overrides";
import { isSeen } from "@/lib/db/repos/seen";
import type { McpContext } from "@/lib/mcp/context";
import { trackingBlockDto } from "@/lib/mcp/dto/job-tracking";
import { isoOrNull } from "@/lib/mcp/dto/shared";

import type { JobBlockSource } from "./source";

export async function loadTracking(ctx: McpContext, { detail, clean }: Pick<JobBlockSource, "detail" | "clean">): Promise<z.infer<typeof trackingBlockDto>> {
  const [seen, override] = await Promise.all([isSeen(ctx.db, detail.id), getFilterOverride(ctx.db, detail.id)]);
  const application = detail.application;
  return {
    application: application ? { status: application.status, status_changed_at: application.statusChangedAt.toISOString(), created_at: application.createdAt.toISOString(), next_action: application.nextAction === null ? null : clean(application.nextAction), next_action_at: isoOrNull(application.nextActionAt), interview_rounds: application.interviewRounds, history: detail.applicationEvents.map((event) => ({ from: event.fromStatus, to: event.toStatus, at: event.at.toISOString() })) } : null,
    favorite: detail.favorite ? { since: detail.favorite.createdAt.toISOString() } : null,
    seen,
    closure: { auto_status: detail.closure.autoStatus, reason: detail.closure.reason, override: detail.closure.override ? { action: detail.closure.override.action, at: detail.closure.override.createdAt.toISOString() } : null, link_check: detail.closure.linkCheck ? { outcome: detail.closure.linkCheck.outcome, checked_at: detail.closure.linkCheck.at } : null },
    filter_override: override,
  };
}
