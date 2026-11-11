import { z } from "zod";

import { DEFAULT_PERMISSIONS, permissionSchema } from "@/lib/agent-access/permissions";

/** Bounds of the limits: a typo cannot turn a tool into a dump of the whole database. */
export const MCP_MAX_RESULTS_CAP = 100;
export const MCP_MAX_DESCRIPTION_CHARS_CAP = 100_000;
export const MCP_MAX_DAILY_CAP = 100_000;

export const AGENT_ACTIONS = [
  "run_collection", "score_jobs", "translate_job", "breakdown_job",
  "research_salary", "research_company", "draft_answer", "tailor_resume",
] as const;
export type AgentAction = typeof AGENT_ACTIONS[number];

const cap = z.number().int().min(0).max(MCP_MAX_DAILY_CAP);
const perCallerDefaults = (): Record<AgentAction, number> => ({
  run_collection: 2, score_jobs: 100, translate_job: 20, breakdown_job: 20,
  research_salary: 10, research_company: 10, draft_answer: 20, tailor_resume: 5,
});

/** Daily agent limits use the calendar day in schedule.yaml's time zone. */
const budgetsSchema = z.strictObject({
  /** Daily caps per caller: stdio and each token count separately; 0 forbids agents from triggering that action. */
  per_caller: z.strictObject({
    run_collection: cap.default(2),
    /** Counts jobs: each job in a batch consumes one unit. */
    score_jobs: cap.default(100),
    translate_job: cap.default(20),
    breakdown_job: cap.default(20),
    /** Also counts automatic salary lookups started indirectly by an agent's write. */
    research_salary: cap.default(10),
    /** Also counts automatic company lookups started indirectly by an agent's write. */
    research_company: cap.default(10),
    draft_answer: cap.default(20),
    tailor_resume: cap.default(5),
  }).default(perCallerDefaults),
  /** Requests per day across all agents and actions; a batch counts once. 0 forbids all agent actions. */
  total: cap.default(150),
}).default(() => ({ per_caller: perCallerDefaults(), total: 150 }));

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
  budgets: budgetsSchema,
});

export type McpConfig = z.infer<typeof mcpSchema>;
export type McpBudgets = McpConfig["budgets"];
