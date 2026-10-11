/**
 * Whether `claude` / `codex` are installed and signed in on this computer, for `pnpm run setup` (host only). Read-only
 * status commands, the same ones the doctor runs (`claude auth status`, `codex login status`); no AI call is made.
 */
import { z } from "zod";

import type { CommandOutcome } from "@/lib/ops/doctor/types";

export type CliLoginState = "logged_in" | "logged_out" | "missing" | "unknown";

export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandOutcome>;

const claudeStatusSchema = z.object({ loggedIn: z.boolean() });

/** The first JSON object in a command's output (claude may print a banner first). */
function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function claudeLoginState(run: RunCommand, command: string): Promise<CliLoginState> {
  const out = await run(command, ["auth", "status"]);
  if (out.kind === "missing") return "missing";
  if (out.kind === "timeout") return "unknown";
  const parsed = claudeStatusSchema.safeParse(firstJson(out.stdout));
  if (!parsed.success) return "unknown";
  return parsed.data.loggedIn ? "logged_in" : "logged_out";
}

export async function codexLoginState(run: RunCommand, command: string): Promise<CliLoginState> {
  const out = await run(command, ["login", "status"]);
  if (out.kind === "missing") return "missing";
  if (out.kind === "timeout") return "unknown";
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.exitCode === 0 && /logged in/i.test(text)) return "logged_in";
  if (/not logged in|logged out/i.test(text) || out.exitCode !== 0) return "logged_out";
  return "unknown";
}
