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

import { get_today } from "./jobs/get-today";
import { list_companies } from "./jobs/list-companies";
import { get_company } from "./jobs/get-company";
import { get_insights } from "./jobs/get-insights";
import { get_application } from "./tracking/get-application";
import { list_favorites } from "./tracking/list-favorites";

import { run_collection } from "./actions/run-collection";
import { score_jobs } from "./actions/score-jobs";
import { translate_job } from "./actions/translate-job";
import { breakdown_job } from "./actions/breakdown-job";
import { research_salary } from "./actions/research-salary";
import { research_company } from "./actions/research-company";
import { draft_answer } from "./actions/draft-answer";
import { tailor_resume } from "./actions/tailor-resume";
import { get_request_status } from "./actions/get-request-status";

export const CAPABILITIES: readonly Capability[] = [
  search_jobs,
  get_job,
  list_applications,
  get_today,
  list_companies,
  get_company,
  get_insights,
  get_application,
  list_favorites,
  get_application_context,
  save_application_answer,
  run_collection,
  score_jobs,
  translate_job,
  breakdown_job,
  research_salary,
  research_company,
  draft_answer,
  tailor_resume,
  get_request_status,
];

/** The capabilities a client is offered now: authorized against one fresh read of mcp.yaml (none when it cannot be read), and available. */
export async function visibleCapabilities(capabilities: readonly Capability[], ctx: Pick<McpContext, "readSettings" | "writer" | "actions">): Promise<readonly Capability[]> {
  return (await listedCapabilities(capabilities, ctx)).map(({ capability }) => capability);
}

/** A list and its caller's effective permissions share one fresh settings read, including a failed read. */
export async function listedCapabilities(capabilities: readonly Capability[], ctx: Pick<McpContext, "readSettings" | "writer" | "actions">): Promise<{ capability: Capability; permissions: ReadonlySet<Permission> }[]> {
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
  return (await Promise.all(capabilities.map(async (capability) => {
    const decision = authorize(capability, once);
    return decision.allowed && (await capability.availability?.available(ctx) ?? true) ? [{ capability, permissions: decision.permissions }] : [];
  }))).flat();
}
