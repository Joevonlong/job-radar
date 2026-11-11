import { z } from "zod";

export const agentCallerSchema = z.union([z.literal("stdio"), z.number().int().positive()]);
export type AgentCaller = z.infer<typeof agentCallerSchema>;

/** Untrusted web input never names an agent caller: the marker is set by the server on an agent's request only. */
export function withoutCaller(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !Object.hasOwn(raw, "caller")) return raw;
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "caller"));
}

export function callerKey(caller: AgentCaller): string {
  return caller === "stdio" ? "stdio" : `token:${caller}`;
}
