/**
 * Fictional agent audit rows for development and the preview: local stdio calls and calls from two sample tokens (one active,
 * one revoked), every result, spread over ten days with a few rows sharing an instant. Replaces what an earlier seed run wrote;
 * like the rest of the seed it is only for disposable and development databases.
 */
import { eq, inArray, or } from "drizzle-orm";

import type { Executor } from "./executor";
import { agentCalls, agentTokens, applications } from "./schema";

const SAMPLE_TOKENS = [
  { name: "Sample laptop agent", hash: "seed-sample-token-laptop", prefix: "jr_seed1", revoked: false },
  { name: "Sample old notebook", hash: "seed-sample-token-notebook", prefix: "jr_seed2", revoked: true },
] as const;

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

export async function seedAgentCalls(db: Executor, input: { now: Date; jobIds: number[] }): Promise<number> {
  const { now, jobIds } = input;
  const names = SAMPLE_TOKENS.map((token) => token.name);
  const previous = await db.select({ id: agentTokens.id }).from(agentTokens).where(inArray(agentTokens.name, names));
  const previousIds = previous.map((row) => row.id);
  await db.delete(agentCalls).where(previousIds.length > 0 ? or(eq(agentCalls.caller, "stdio"), inArray(agentCalls.tokenId, previousIds)) : eq(agentCalls.caller, "stdio"));
  if (previousIds.length > 0) await db.delete(agentTokens).where(inArray(agentTokens.id, previousIds));
  const tokens = await db
    .insert(agentTokens)
    .values(SAMPLE_TOKENS.map((token) => ({
      name: token.name,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      permissions: ["jobs:read", "tracking:read", "writer:write"],
      revokedAt: token.revoked ? new Date(now.getTime() - 2 * 86_400_000) : null,
      lastUsedAt: new Date(now.getTime() - (token.revoked ? 3 * 86_400_000 : 3_600_000)),
    })))
    .returning({ id: agentTokens.id, name: agentTokens.name });
  const laptop = tokens.find((token) => token.name === SAMPLE_TOKENS[0].name)?.id ?? null;
  const notebook = tokens.find((token) => token.name === SAMPLE_TOKENS[1].name)?.id ?? null;
  const applicationRows = jobIds.length === 0 ? [] : await db.select({ id: applications.id }).from(applications).where(inArray(applications.jobId, jobIds)).limit(6);
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
