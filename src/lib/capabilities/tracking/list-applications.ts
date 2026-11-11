import { blockList } from "../blocks";
import { applicationNotesBlocks } from "@/lib/mcp/tracking-blocks";
import { listApplicationsOutputFor } from "@/lib/mcp/dto/tracking";
import { listApplicationsOutput } from "@/lib/mcp/dto";
import { listApplications, listApplicationsInput } from "@/lib/mcp/tools/list-applications";

import { defineCapability, READ_ONLY } from "../types";

export const list_applications = defineCapability({
  id: "list_applications",
  kind: "read",
  permission: "tracking:read",
  input: listApplicationsInput,
  output: listApplicationsOutput,
  outputFor: listApplicationsOutputFor,
  blocks: blockList(applicationNotesBlocks),
  handler: listApplications,
  count: (output) => output.returned,
  annotations: READ_ONLY,
  text: { title: "tools.list_applications.title", description: "tools.list_applications.description" },
});
