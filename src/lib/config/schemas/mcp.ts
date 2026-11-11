import { z } from "zod";

import { DEFAULT_PERMISSIONS, permissionSchema } from "@/lib/agent-access/permissions";

/** Bounds of the limits: a typo cannot turn a tool into a dump of the whole database. */
export const MCP_MAX_RESULTS_CAP = 100;
export const MCP_MAX_DESCRIPTION_CHARS_CAP = 100_000;

/**
 * config/mcp.yaml: the optional MCP server (`pnpm mcp:serve`, docs/mcp.md) that lets an MCP client the user configured (Claude
 * Desktop, Claude Code, ...) query jobs and applications over stdio and, with writer permissions, add answer versions. Every key has a default, so a missing file means
 * "off" and the defaults below. What the server may return is fixed in code (`src/lib/mcp/dto.ts`), not here.
 */
export const mcpSchema = z.strictObject({
  /** Off by default: `pnpm mcp:serve` refuses to start until this is true. */
  enabled: z.boolean().default(false),
  /** The global permission matrix: the most any connection may receive. */
  permissions: z.array(permissionSchema).default([...DEFAULT_PERMISSIONS]),
  /** The local connection receives only stdio.permissions intersected with permissions. */
  stdio: z.strictObject({
    permissions: z.array(permissionSchema).default([...DEFAULT_PERMISSIONS]),
  }).default({ permissions: [...DEFAULT_PERMISSIONS] }),
  audit: z.strictObject({
    retention_days: z.number().int().min(1).max(3650).default(90),
    connect_timeout_seconds: z.number().int().min(1).max(30).default(2),
    statement_timeout_ms: z.number().int().min(1).max(60_000).default(1500),
    lock_timeout_ms: z.number().int().min(1).max(60_000).default(200),
    /**
     * Client deadline of one audit row written outside a transaction, from the call's end through its wait in line and the
     * database's reply; also the longest shutdown waits for the last calls and rows.
     */
    write_timeout_ms: z.number().int().min(100).max(10_000).default(2000),
  }).default({ retention_days: 90, connect_timeout_seconds: 2, statement_timeout_ms: 1500, lock_timeout_ms: 200, write_timeout_ms: 2000 }),
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
