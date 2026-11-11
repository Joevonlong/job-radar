import { getApplicationOutput, getApplicationOutputFor } from "@/lib/mcp/dto/read-tracking";
import { blockList } from "../blocks";
import { applicationDetailNotesBlocks } from "@/lib/mcp/tracking-blocks";
import { getApplication, getApplicationInput } from "@/lib/mcp/tools/get-application";
import { defineCapability, READ_ONLY } from "../types";

export const get_application = defineCapability({
  id: "get_application", kind: "read", permission: "tracking:read",
  input: getApplicationInput, output: getApplicationOutput, handler: getApplication,
  blocks: blockList(applicationDetailNotesBlocks),
  outputFor: getApplicationOutputFor,
  target: (args) => ({ type: "job", id: args.job_id }),
  count: () => 1, annotations: READ_ONLY,
  text: { title: "tools.get_application.title", description: "tools.get_application.description" },
});
