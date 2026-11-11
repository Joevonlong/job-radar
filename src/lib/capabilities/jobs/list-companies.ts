import { listCompaniesOutput } from "@/lib/mcp/dto/companies";
import { listCompanies, listCompaniesInput } from "@/lib/mcp/tools/list-companies";
import { defineCapability, READ_ONLY } from "../types";

export const list_companies = defineCapability({
  id: "list_companies", kind: "read", permission: "jobs:read",
  input: listCompaniesInput, output: listCompaniesOutput, handler: listCompanies,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.list_companies.title", description: "tools.list_companies.description" },
});
