import { z } from "zod";

import { DEFAULT_PERMISSIONS, permissionSchema } from "@/lib/agent-access/permissions";

/** Bounds of the limits: a typo cannot turn a tool into a dump of the whole database. */
export const MCP_MAX_RESULTS_CAP = 100;
export const MCP_MAX_DESCRIPTION_CHARS_CAP = 100_000;
export const MCP_MAX_RAW_CHARS_CAP = 1_000_000;
export const MCP_MAX_DAILY_CAP = 100_000;

export const AGENT_ACTIONS = [
  "run_collection", "score_jobs", "translate_job", "breakdown_job",
  "research_salary", "research_company", "draft_answer", "tailor_resume",
] as const;
export type AgentAction = typeof AGENT_ACTIONS[number];

const cap = z.number().int().min(0).max(MCP_MAX_DAILY_CAP);
const perCallerDefaults = (): Record<AgentAction, number> => ({
  run_collection: 2, score_jobs: 300, translate_job: 60, breakdown_job: 20,
  research_salary: 10, research_company: 10, draft_answer: 20, tailor_resume: 5,
});

/** Daily agent limits use the calendar day in schedule.yaml's time zone. */
const budgetsSchema = z.strictObject({
  /** Daily caps per caller: stdio and each token count separately; 0 forbids agents from triggering that action. */
  per_caller: z.strictObject({
    run_collection: cap.default(2),
    /** Counts jobs: each job in a batch consumes one unit. */
    score_jobs: cap.default(300),
    translate_job: cap.default(60),
    breakdown_job: cap.default(20),
    /** Also counts automatic salary lookups started indirectly by an agent's write. */
    research_salary: cap.default(10),
    /** Also counts automatic company lookups started indirectly by an agent's write. */
    research_company: cap.default(10),
    draft_answer: cap.default(20),
    tailor_resume: cap.default(5),
  }).default(perCallerDefaults),
  /** Requests, not jobs, per day across all agents and actions; a `score_jobs` batch counts once. 0 forbids all agent actions. */
  total: cap.default(200),
}).default(() => ({ per_caller: perCallerDefaults(), total: 200 }));

/**
 * config/mcp.yaml: the optional MCP server (`pnpm mcp:serve`, docs/mcp.md) that lets an MCP client the user configured (Claude
 * Desktop, Claude Code, ...) query jobs and applications over stdio or optional token-protected HTTP, add permitted answer versions, and queue budgeted actions. Every key has a default, so a missing file means
 * "off" and the defaults below. What the server may return is fixed in code (`src/lib/mcp/dto/index.ts`), not here.
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
  http: z.strictObject({
    enabled: z.boolean().default(false),
    max_body_bytes: z.number().int().min(1024).max(4_194_304).default(262_144),
    pool: z.strictObject({
      read_max: z.number().int().min(1).max(20).default(3),
      write_max: z.number().int().min(1).max(10).default(2),
      max_concurrent: z.number().int().min(1).max(64).default(8),
    }).prefault({}),
    throttle: z.strictObject({
      max_failures: z.number().int().min(1).max(100).default(5),
      window_minutes: z.number().int().min(1).max(1440).default(10),
      lockout_minutes: z.number().int().min(1).max(1440).default(15),
      global_max_failures: z.number().int().min(1).max(10_000).default(50),
      global_delay_seconds: z.number().int().min(1).max(3600).default(2),
    }).prefault({}),
  }).prefault({}),
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
      /** Most results per list or usage dimension, including expanded runs, activity spans and events; truncation is marked. */
      max_results: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).default(20),
      /** Most characters of a JD one `get_job` call returns; a longer JD is cut and marked as cut. */
      max_description_chars: z.number().int().min(500).max(MCP_MAX_DESCRIPTION_CHARS_CAP).default(12_000),
      /** Total serialized payload characters across all sources of one raw-posting call. */
      max_raw_chars: z.number().int().min(500).max(MCP_MAX_RAW_CHARS_CAP).default(20_000),
    })
    .default({ max_results: 20, max_description_chars: 12_000, max_raw_chars: 20_000 }),
  budgets: budgetsSchema,
});

export type McpConfig = z.infer<typeof mcpSchema>;
export type McpBudgets = McpConfig["budgets"];
