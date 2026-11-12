import { listChannelsOutput } from "@/lib/mcp/dto/ops";
import { listChannels, listChannelsInput } from "@/lib/mcp/tools/list-channels";
import { defineCapability, READ_ONLY } from "../types";

export const list_channels = defineCapability({
  id: "list_channels", kind: "read", permission: "ops:read",
  input: listChannelsInput, output: listChannelsOutput, handler: listChannels,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.list_channels.title", description: "tools.list_channels.description" },
});
