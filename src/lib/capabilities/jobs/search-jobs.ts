import { searchJobCardBlocks } from "@/lib/mcp/job-card-blocks";
import { searchJobsOutput, searchJobsOutputFor } from "@/lib/mcp/dto";
import { searchJobs, searchJobsInput } from "@/lib/mcp/tools/search-jobs";

import { blockList } from "../blocks";
import { defineCapability, READ_ONLY } from "../types";

export const search_jobs = defineCapability({
  id: "search_jobs",
  kind: "read",
  permission: "jobs:read",
  input: searchJobsInput,
  output: searchJobsOutput,
  blocks: blockList(searchJobCardBlocks),
  outputFor: (p) => searchJobsOutputFor(p),
  handler: searchJobs,
  count: (output) => output.returned,
  annotations: READ_ONLY,
  text: { title: "tools.search_jobs.title", description: "tools.search_jobs.description" },
});
