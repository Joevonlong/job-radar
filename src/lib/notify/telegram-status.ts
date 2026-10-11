/**
 * What the web shows about Telegram (Settings -> Notifications and the setup wizard): whether the bot token and the chat
 * id are set (names and booleans only, never a value, C4), whether the push is on, and the last test message. The values
 * are configured on the host with `pnpm run setup --step telegram`; the web never reads them out nor writes `.env`.
 * Server only.
 */
import { z } from "zod";

import type { Db } from "@/lib/db/client";
import { getLatestFinishedControlRequest } from "@/lib/db/repos/control-requests";
import { loadTelegramEnv } from "@/lib/env";
import { envPresence, isSet, type EnvSource } from "@/lib/setup/env";
import type { EnvPresence } from "@/lib/setup/types";

/** The command that sets up, replaces, tests or removes the bot (shown to copy). */
export const TELEGRAM_SETUP_COMMAND = "pnpm run setup --step telegram";

export const TELEGRAM_STATUS_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS"] as const;

/** `missing`: neither value; `partial`: one of them; `invalid`: both, but malformed; `configured`: both and well-formed. */
export type TelegramSetupState = "missing" | "partial" | "invalid" | "configured";

export interface TelegramLastTest {
  ok: boolean;
  /** ISO time it finished; null when unknown. */
  at: string | null;
  /** The error code of a failed test (`telegram_not_configured`, `telegram_failed`, ...). */
  error: string | null;
}

export interface TelegramStatusView {
  state: TelegramSetupState;
  /** The three variables by name, with whether each is set. */
  env: EnvPresence[];
  /** notify.yaml `telegram.enabled`; null when notify.yaml cannot be read. */
  enabled: boolean | null;
  /** The newest finished test message request; null when there was none or the database is not reachable. */
  lastTest: TelegramLastTest | null;
  command: string;
}

export function telegramSetupState(env: EnvSource = process.env): TelegramSetupState {
  const token = isSet(env, "TELEGRAM_BOT_TOKEN");
  const chat = isSet(env, "TELEGRAM_CHAT_ID");
  if (!token && !chat) return "missing";
  if (!token || !chat) return "partial";
  try {
    return loadTelegramEnv(env) === null ? "missing" : "configured";
  } catch {
    return "invalid";
  }
}

const resultErrorSchema = z.object({ error: z.string().max(64) }).partial().catch({});

export async function loadTelegramLastTest(db: Db): Promise<TelegramLastTest | null> {
  const row = await getLatestFinishedControlRequest(db, "test_telegram");
  if (row === null) return null;
  const ok = row.status === "done";
  return { ok, at: row.finishedAt?.toISOString() ?? null, error: ok ? null : (resultErrorSchema.parse(row.result ?? {}).error ?? null) };
}

/** The status block; `db` null (or failing) leaves out the last test. */
export async function loadTelegramStatus(input: { enabled: boolean | null; db: Db | null; env?: EnvSource }): Promise<TelegramStatusView> {
  const env = input.env ?? process.env;
  let lastTest: TelegramLastTest | null = null;
  if (input.db !== null) {
    try {
      lastTest = await loadTelegramLastTest(input.db);
    } catch {
      lastTest = null;
    }
  }
  return { state: telegramSetupState(env), env: envPresence(TELEGRAM_STATUS_ENV, env), enabled: input.enabled, lastTest, command: TELEGRAM_SETUP_COMMAND };
}
