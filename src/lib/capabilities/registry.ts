/** Adding a tool means one definition file plus one line here. */
import { authorize } from "@/lib/agent-access/authorize";
import type { Permission } from "@/lib/agent-access/permissions";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import type { McpContext } from "@/lib/mcp/context";

import { get_job } from "./jobs/get-job";
import { search_jobs } from "./jobs/search-jobs";
import { list_applications } from "./tracking/list-applications";
import type { Capability } from "./types";
import { get_application_context } from "./writer/get-application-context";
import { save_application_answer } from "./writer/save-application-answer";

import { get_system_status } from "./ops/get-system-status";
import { list_cycles } from "./ops/list-cycles";
import { list_channels } from "./ops/list-channels";
import { get_activity_log } from "./ops/get-activity-log";
import { get_ai_usage } from "./ops/get-ai-usage";

export const CAPABILITIES: readonly Capability[] = [
  search_jobs,
  get_job,
  list_applications,
  get_application_context,
  save_application_answer,
  get_system_status,
  list_cycles,
  list_channels,
  get_activity_log,
  get_ai_usage,
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
