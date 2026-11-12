import { listCyclesOutput } from "@/lib/mcp/dto/ops";
import { listCycles, listCyclesInput } from "@/lib/mcp/tools/list-cycles";
import { defineCapability, READ_ONLY } from "../types";

export const list_cycles = defineCapability({
  id: "list_cycles", kind: "read", permission: "ops:read",
  input: listCyclesInput, output: listCyclesOutput, handler: listCycles,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.list_cycles.title", description: "tools.list_cycles.description" },
});
