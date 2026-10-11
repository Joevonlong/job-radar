import { z } from "zod";

/** The tools the MCP server can offer; every one of them only reads. Each can be switched off in mcp.yaml `tools`. */
export const MCP_TOOL_NAMES = ["search_jobs", "get_job", "list_applications"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Bounds of the limits: a typo cannot turn a tool into a dump of the whole database. */
export const MCP_MAX_RESULTS_CAP = 100;
export const MCP_MAX_DESCRIPTION_CHARS_CAP = 100_000;

const toolSwitches = z.strictObject(Object.fromEntries(MCP_TOOL_NAMES.map((name) => [name, z.boolean().default(true)])) as Record<McpToolName, z.ZodDefault<z.ZodBoolean>>);

/**
 * config/mcp.yaml: the optional read-only MCP server (`pnpm mcp:serve`, docs/mcp.md) that lets an MCP client the user configured
 * (Claude Desktop, Claude Code, ...) query jobs and applications over stdio. Every key has a default, so a missing file means
 * "off" and the defaults below. What the server may return is fixed in code (`src/lib/mcp/dto.ts`), not here.
 */
export const mcpSchema = z.strictObject({
  /** Off by default: `pnpm mcp:serve` refuses to start until this is true. */
  enabled: z.boolean().default(false),
  /** Each tool can be switched off on its own (a switched-off tool is not listed to the client). */
  tools: toolSwitches.default({ search_jobs: true, get_job: true, list_applications: true }),
  limits: z
    .strictObject({
      /** Most jobs or applications one call returns; the rest is cut and the answer says so. */
      max_results: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).default(20),
      /** Most characters of a JD one `get_job` call returns; a longer JD is cut and marked as cut. */
      max_description_chars: z.number().int().min(500).max(MCP_MAX_DESCRIPTION_CHARS_CAP).default(12_000),
    })
    .default({ max_results: 20, max_description_chars: 12_000 }),
});

export type McpConfig = z.infer<typeof mcpSchema>;
