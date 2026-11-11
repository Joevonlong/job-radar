/** Adding a tool means one definition file plus one line here. */
import { authorize } from "@/lib/agent-access/authorize";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import type { McpContext } from "@/lib/mcp/context";

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
  get_application_context,
  save_application_answer,
];

/** The capabilities a client is offered now: authorized against one fresh read of mcp.yaml (none when it cannot be read), and available. */
export function visibleCapabilities(capabilities: readonly Capability[], ctx: Pick<McpContext, "readSettings" | "writer">): readonly Capability[] {
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
  return capabilities.filter((capability) => authorize(capability, once).allowed && (capability.available?.(ctx) ?? true));
}
