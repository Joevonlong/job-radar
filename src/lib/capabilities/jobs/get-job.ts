import { getJobOutput } from "@/lib/mcp/dto";
import { getJob, getJobInput } from "@/lib/mcp/tools/get-job";

import { defineCapability, READ_ONLY } from "../types";

export const get_job = defineCapability({
  id: "get_job",
  kind: "read",
  permission: "jobs:read",
  input: getJobInput,
  output: getJobOutput,
  handler: getJob,
  count: () => 1,
  annotations: READ_ONLY,
  text: { title: "tools.get_job.title", description: "tools.get_job.description" },
});
