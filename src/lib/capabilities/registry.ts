/** Adding a tool means one definition file plus one line here. */
import { authorize } from "@/lib/agent-access/authorize";
import type { Permission } from "@/lib/agent-access/permissions";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import type { McpContext } from "@/lib/mcp/context";

import { get_profile } from "./profile/get-profile";
import { get_interests } from "./profile/get-interests";
import { preview_deal_breakers } from "./profile/preview-deal-breakers";
import { preview_interest_category } from "./profile/preview-interest-category";
import { get_job } from "./jobs/get-job";
import { search_jobs } from "./jobs/search-jobs";
import { list_applications } from "./tracking/list-applications";
import type { Capability } from "./types";
import { get_application_context } from "./writer/get-application-context";
import { save_application_answer } from "./writer/save-application-answer";

export const CAPABILITIES: readonly Capability[] = [
  search_jobs,
  get_job,
  list_applications,
  get_profile,
  get_interests,
  preview_deal_breakers,
  preview_interest_category,
  get_application_context,
  save_application_answer,
];

/** The capabilities a client is offered now: authorized against one fresh read of mcp.yaml (none when it cannot be read), and available. */
export function visibleCapabilities(capabilities: readonly Capability[], ctx: Pick<McpContext, "readSettings" | "writer">): readonly Capability[] {
  return listedCapabilities(capabilities, ctx).map(({ capability }) => capability);
}

/** A list and its caller's effective permissions share one fresh settings read, including a failed read. */
export function listedCapabilities(capabilities: readonly Capability[], ctx: Pick<McpContext, "readSettings" | "writer">): { capability: Capability; permissions: ReadonlySet<Permission> }[] {
  let read: { settings: McpConfig } | { error: unknown };
  try {
    read = { settings: ctx.readSettings() };
  } catch (error) {
    read = { error };
  }
  const once = (): McpConfig => {
    if ("error" in read) throw read.error;
    return read.settings;
  };
  return capabilities.flatMap((capability) => {
    const decision = authorize(capability, once);
    return decision.allowed && (capability.availability?.available(ctx) ?? true) ? [{ capability, permissions: decision.permissions }] : [];
  });
}
