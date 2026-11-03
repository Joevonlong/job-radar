import type { WriterConfig } from "@/lib/config";
import type { WriterInputs } from "@/lib/writer/settings";

import { ToolFailure, type McpContext } from "../context";

/** The application writer's files for a call; refused while the writer is off, also when it was switched off after the client connected. */
export function readWriterForTool(ctx: McpContext): WriterInputs & { writer: WriterConfig } {
  const inputs = ctx.writer?.inputs();
  if (!inputs?.writer?.enabled) throw new ToolFailure("disabled", ctx.text("errors.writerDisabled"));
  return { ...inputs, writer: inputs.writer };
}
