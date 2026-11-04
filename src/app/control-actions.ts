"use server";

import { revalidatePath } from "next/cache";

import { runCyclePayloadSchema } from "@/lib/control/types";

import { addSyncedModels, type AddSyncedModelsState } from "@/lib/control/models-sync-add";
import { requestModelsSync, requestRunCycle, requestTestAi, requestTestChannel, requestTestTelegram, type ControlActionState } from "@/lib/control/service";

// The trigger buttons of /sources and /settings. Server Actions are public POST endpoints: everything arriving
// here is validated again in the service (zod), and the web server only listens on 127.0.0.1 / Tailscale.

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

/** "Refresh models" of a provider on /settings: the ai-worker reads the provider's model list. */
export async function modelsSyncAction(payload: unknown): Promise<ControlActionState> {
  return requestModelsSync(payload);
}

/** "Add to my list" under the refreshed model list: writes the ticked models of that request to the user's models.yaml. */
export async function addSyncedModelsAction(payload: unknown): Promise<AddSyncedModelsState> {
  const result = await addSyncedModels(payload);
  if (result.status === "added") revalidatePath("/settings");
  return result;
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
