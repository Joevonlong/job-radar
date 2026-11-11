import { getCompanyOutput } from "@/lib/mcp/dto/companies";
import { getCompany, getCompanyInput } from "@/lib/mcp/tools/get-company";
import { defineCapability, READ_ONLY } from "../types";

export const get_company = defineCapability({
  id: "get_company", kind: "read", permission: "jobs:read",
  input: getCompanyInput, output: getCompanyOutput, handler: getCompany,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.get_company.title", description: "tools.get_company.description" },
});
