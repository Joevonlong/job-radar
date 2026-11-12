import { getJobRawOutput } from "@/lib/mcp/dto/raw";
import { getJobRaw, getJobRawInput } from "@/lib/mcp/tools/get-job-raw";
import { defineCapability, READ_ONLY } from "../types";

export const get_job_raw = defineCapability({
  id: "get_job_raw", kind: "read", permission: "raw:read",
  input: getJobRawInput, output: getJobRawOutput, handler: getJobRaw,
  count: (output) => output.sources.length,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: READ_ONLY,
  text: { title: "tools.get_job_raw.title", description: "tools.get_job_raw.description" },
});
