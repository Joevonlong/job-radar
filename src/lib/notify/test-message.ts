import { escapeHtml } from "./format";
import type { TelegramRuntime } from "./runtime";
import { notifyText, type NotifyText } from "./text";

export interface TestMessageResult {
  botUsername: string | null;
  messageId: number;
}

/** `pnpm telegram:test`: confirm the token works (`getMe`) and the chat can be written to. */
export async function sendTestMessage(runtime: TelegramRuntime, at: Date = new Date(), text: NotifyText = notifyText()): Promise<TestMessageResult> {
  const me = await runtime.client.getMe();
  const sent = await runtime.client.sendMessage({
    chatId: runtime.chatId,
    text: `<b>✅ Job Radar</b>\n${escapeHtml(text.t("test"))}\n<i>${escapeHtml(at.toISOString())}</i>`,
  });
  return { botUsername: me.username, messageId: sent.messageId };
}
