import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import type { AuditTarget } from "@/lib/agent-access/audit";
import type { McpContext } from "@/lib/mcp/context";

type CapabilityOutput = { notices: string[] } & Record<string, unknown>;
type MessageKey = Parameters<McpContext["text"]>[0];

export interface Capability {
  id: string;
  kind: "read" | "write" | "trigger";
  permission: Permission;
  input: (ctx: Pick<McpContext, "text">) => z.ZodObject;
  output: z.ZodType<CapabilityOutput>;
  handler: (ctx: McpContext, args: unknown) => Promise<CapabilityOutput>;
  count: (output: CapabilityOutput) => number;
  target?: (args: unknown) => AuditTarget | null;
  annotations: ToolAnnotations;
  text: { title: MessageKey; description: MessageKey };
  /**
   * Whether it can be offered and called at all right now, besides permissions (the application writer switched on, ...), and the
   * failure a call gets when it cannot. The list and the call apply the same rule.
   */
  availability?: { available: (ctx: Pick<McpContext, "writer">) => boolean; category: string; message: MessageKey };
  blocks?: readonly { key: string; permission: Permission; onRequest: boolean }[];
  outputFor?: (permissions: ReadonlySet<Permission>) => z.ZodType<CapabilityOutput>;
}

type CapabilityDefinition<I extends z.ZodObject, O extends z.ZodType<CapabilityOutput>> = Omit<Capability, "input" | "output" | "handler" | "count" | "target" | "outputFor"> & {
  input: (ctx: Pick<McpContext, "text">) => I;
  output: O;
  handler: (ctx: McpContext, args: z.output<I>) => Promise<z.output<O>>;
  count: (output: z.output<O>) => number;
  target?: (args: z.output<I>) => AuditTarget | null;
  outputFor?: (permissions: ReadonlySet<Permission>) => z.ZodType<z.output<O>>;
};

/** The SDK validates inputs and outputs; only this registry boundary erases each definition's matching schema types. */
export function defineCapability<I extends z.ZodObject, O extends z.ZodType<CapabilityOutput>>(definition: CapabilityDefinition<I, O>): Capability {
  const erased: unknown = definition;
  return erased as Capability;
}

/** These tools only read, and read only this installation's own database. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Adds a row and changes or removes nothing; calling it twice adds two. */
export const ADDS_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
