/**
 * Setup step 7 (optional): Telegram. Switches the push on / off (notify.yaml `telegram.enabled`) and sets the message
 * language (language.yaml `notify.locale`). The bot token and chat id are never read or written here: the wizard only
 * says whether TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are set.
 */
import { mutateConfig } from "@/lib/config";

import { isSet, TELEGRAM_ENV, type EnvSource } from "../env";
import { telegramInputSchema } from "../inputs";
import { stepError, type SetupStepResult } from "../types";
import { finishStep, readFresh, setupFrozen, setupWriteError } from "./common";
import { writeNotifyLocale } from "./language";

export async function saveTelegramStep(raw: unknown): Promise<SetupStepResult> {
  const frozen = setupFrozen("telegram");
  if (frozen) return frozen;
  const parsed = telegramInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("telegram", "invalidPayload");
  const notify = readFresh("notify");
  if (notify === null) return stepError("telegram", "configUnreadable");
  if (parsed.data.notify_locale !== undefined) {
    const problem = await writeNotifyLocale(parsed.data.notify_locale);
    if (problem !== null) return problem;
  }
  try {
    await mutateConfig("notify", (current) => current.telegram.enabled === parsed.data.enabled ? null : { ...current, telegram: { ...current.telegram, enabled: parsed.data.enabled } });
  } catch (error) {
    return stepError("telegram", setupWriteError(error));
  }
  return finishStep("telegram");
}

/**
 * Skipping the Telegram step must not leave an enabled push without a bot: when neither TELEGRAM_BOT_TOKEN nor
 * TELEGRAM_CHAT_ID is set, `telegram.enabled` is switched off (the doctor and the runner otherwise complain on every
 * cycle). A push that is already configured (either variable set) is left alone. Returns true when the file changed.
 */
export async function disableTelegramIfUnconfigured(env: EnvSource = process.env): Promise<boolean> {
  if (TELEGRAM_ENV.some((name) => isSet(env, name))) return false;
  try {
    const changed = await mutateConfig("notify", (current) => current.telegram.enabled ? { ...current, telegram: { ...current.telegram, enabled: false } } : null);
    return changed !== null;
  } catch {
    return false;
  }
}
