"use server";

import { runCyclePayloadSchema } from "@/lib/control/types";

import { requestRunCycle, requestTestAi, requestTestChannel, requestTestTelegram, type ControlActionState } from "@/lib/control/service";

// The trigger buttons of /sources and /settings. Server Actions are public POST endpoints: everything arriving
// here is validated again in the service (zod), and the web server only listens on 127.0.0.1 / Tailscale (C5).

/** "Collect now" on a channel card: a manual cycle of this one channel (an open cycle request is reused). */
export async function runChannelNowAction(channelId: unknown): Promise<ControlActionState> {
  return requestRunCycle({ channelIds: [channelId] });
}

/** "Test" on a channel card: one small dry fetch, nothing stored. */
export async function testChannelAction(payload: unknown): Promise<ControlActionState> {
  return requestTestChannel(payload);
}

/** "Test" of an AI provider: one tiny probe call on the ai-worker. */
export async function testAiAction(payload: unknown): Promise<ControlActionState> {
  return requestTestAi(payload);
}

/** "Send a Telegram test message" (the page asks for a confirmation first). */
export async function testTelegramAction(): Promise<ControlActionState> {
  return requestTestTelegram();
}

/** A manual backfill: accept only its window and optional channel scope. */
export async function backfillAction(payload: unknown): Promise<ControlActionState> {
  const parsed = runCyclePayloadSchema.required({ backfillHours: true }).safeParse(payload);
  if (!parsed.success) return { status: "error", error: "invalidPayload", nonce: Date.now() };
  return requestRunCycle(parsed.data);
}
