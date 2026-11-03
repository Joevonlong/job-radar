import { z } from "zod";

/** The tools that only read jobs and applications; on unless mcp.yaml `tools` switches them off. */
export const MCP_READ_TOOL_NAMES = ["search_jobs", "get_job", "list_applications"] as const;
/**
 * The application writer's tools: they hand your own material to the client's model provider, or add an answer version. Each one
 * is off until mcp.yaml `tools` switches it on, also in a file written before they existed.
 */
export const MCP_WRITER_TOOL_NAMES = ["get_application_context", "save_application_answer"] as const;
export const MCP_TOOL_NAMES = [...MCP_READ_TOOL_NAMES, ...MCP_WRITER_TOOL_NAMES] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Bounds of the limits: a typo cannot turn a tool into a dump of the whole database. */
export const MCP_MAX_RESULTS_CAP = 100;
export const MCP_MAX_DESCRIPTION_CHARS_CAP = 100_000;

const toolSwitches = z.strictObject({
  search_jobs: z.boolean().default(true),
  get_job: z.boolean().default(true),
  list_applications: z.boolean().default(true),
  // on only when the file says so; absent keeps the effective value of an existing file as it was
  get_application_context: z.boolean().optional(),
  save_application_answer: z.boolean().optional(),
} satisfies Record<McpToolName, z.ZodType<boolean | undefined>>);

/**
 * config/mcp.yaml: the optional MCP server (`pnpm mcp:serve`, docs/mcp.md) that lets an MCP client the user configured (Claude
 * Desktop, Claude Code, ...) query jobs and applications over stdio and, with its two writer tools on, add answer versions. Every key has a default, so a missing file means
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
