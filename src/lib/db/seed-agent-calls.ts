/**
 * Fictional agent audit rows for development and the preview: local stdio calls and calls from the two example agent tokens (one active,
 * one revoked), every result, spread over ten days with a few rows sharing an instant. Replaces what an earlier seed run wrote;
 * like the rest of the seed it is only for disposable and development databases.
 */
import { eq, inArray, or } from "drizzle-orm";

import type { Executor } from "./executor";
import { seedAgentTokenHash, SEED_AGENT_TOKENS } from "./seed-agent-tokens";
import { agentCalls, agentTokens, applications, jobs } from "./schema";

type Row = typeof agentCalls.$inferInsert;
type Target = Pick<Row, "targetType" | "targetId">;

const TOOLS = [
  { id: "search_jobs", target: null },
  { id: "get_job", target: "job" },
  { id: "get_today", target: null },
  { id: "list_applications", target: null },
  { id: "get_application", target: "application" },
  { id: "get_application_context", target: "application" },
  { id: "save_application_answer", target: "question" },
  { id: "get_company", target: null },
  { id: "get_job_raw", target: "job" },
  { id: "get_system_status", target: null },
] as const;

/**
 * Run after `seedAgentTokens` and the job seed, from the seed entry points only (not from `seedDatabase`, which integration
 * tests run and then count the audit table from empty). Gives the example tokens' calls and the local stdio calls back as they
 * were; returns the rows written.
 */
export async function seedAgentCalls(db: Executor, input: { now: Date }): Promise<number> {
  const { now } = input;
  const tokens = await db
    .select({ id: agentTokens.id, hash: agentTokens.tokenHash })
    .from(agentTokens)
    .where(inArray(agentTokens.tokenHash, SEED_AGENT_TOKENS.map((token) => seedAgentTokenHash(token.label))));
  const idOf = (label: string) => tokens.find((token) => token.hash === seedAgentTokenHash(label))?.id ?? null;
  const laptop = idOf(SEED_AGENT_TOKENS[0].label);
  const notebook = idOf(SEED_AGENT_TOKENS[1].label);
  const tokenIds = tokens.map((token) => token.id);
  await db.delete(agentCalls).where(tokenIds.length > 0 ? or(eq(agentCalls.caller, "stdio"), inArray(agentCalls.tokenId, tokenIds)) : eq(agentCalls.caller, "stdio"));
  const jobIds = (await db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id).limit(20)).map((row) => row.id);
  const applicationRows = await db.select({ id: applications.id }).from(applications).orderBy(applications.id).limit(6);
  const applicationIds = applicationRows.map((row) => row.id);

  const targetFor = (type: (typeof TOOLS)[number]["target"], n: number): Target => {
    if (type === "job") return jobIds.length === 0 ? { targetType: null, targetId: null } : { targetType: "job", targetId: jobIds[n % jobIds.length] ?? null };
    if (type === "application") return applicationIds.length === 0 ? { targetType: null, targetId: null } : { targetType: "application", targetId: applicationIds[n % applicationIds.length] ?? null };
    if (type === "question") return { targetType: "question", targetId: 900_000 + n };
    return { targetType: null, targetId: null };
  };

  const rows: Row[] = [];
  const count = 54;
  for (let n = 0; n < count; n += 1) {
    const tool = TOOLS[(n * 7) % TOOLS.length] ?? TOOLS[0];
    const source = n % 3;
    const tokenId = source === 0 ? null : source === 1 ? laptop : notebook;
    const minutesAgo = n < 4 ? 3 + n : Math.round(n * n * 3.3 + n * 40);
    const calledAt = new Date(now.getTime() - minutesAgo * 60_000);
    const failure = n % 11 === 5 ? "error" : n % 13 === 6 ? "not_permitted" : n % 17 === 8 ? "invalid_input" : "ok";
    rows.push({
      calledAt,
      caller: tokenId === null ? "stdio" : `token:${tokenId}`,
      tokenId,
      transport: tokenId === null ? "stdio" : "http",
      capability: tool.id,
      ...targetFor(tool.target, n),
      outcome: failure,
      errorCategory: failure === "error" ? (n % 2 === 0 ? "database" : "timeout") : null,
      returnedCount: failure === "ok" ? (tool.target === null ? 1 + (n % 9) * 3 : 1) : 0,
      durationMs: 12 + ((n * 37) % 480),
    });
  }
  const instant = new Date(now.getTime() - 5 * 3_600_000);
  for (let k = 0; k < 3; k += 1) {
    rows.push({ calledAt: instant, caller: "stdio", tokenId: null, transport: "stdio", capability: "get_job", ...targetFor("job", k + 2), outcome: "ok", errorCategory: null, returnedCount: 1, durationMs: 20 + k });
  }
  await db.insert(agentCalls).values(rows);
  return rows.length;
}
