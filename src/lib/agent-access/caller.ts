import { z } from "zod";

export const agentCallerSchema = z.union([z.literal("stdio"), z.number().int().positive()]);
export type AgentCaller = z.infer<typeof agentCallerSchema>;

export function callerKey(caller: AgentCaller): string {
  return caller === "stdio" ? "stdio" : `token:${caller}`;
}
