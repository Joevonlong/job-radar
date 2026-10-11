/**
 * A static page that shows one job message the way a chat app would: the real `formatJobMessage` output (Telegram's HTML
 * subset: <b>, <i>, <a>) in a plain bubble, with the real button labels below. It is a preview of the message format,
 * not a picture of a real chat, and uses no Telegram artwork.
 */
import { DEMO_BASE_URL } from "../scripts/demo/checks";
import { formatJobMessage, jobKeyboard } from "../src/lib/notify/format";
import type { PushItem } from "../src/lib/notify/select";
import type { NotifyText } from "../src/lib/notify/text";

export interface TelegramPreview {
  /** Exactly what `formatJobMessage` returned. */
  message: string;
  /** The full page to show. */
  html: string;
}

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderTelegramPreview(item: PushItem, text: NotifyText, input: { caption: string; botName: string; time: string; traps?: boolean }): TelegramPreview {
  const message = formatJobMessage(item, text, { publicBaseUrl: DEMO_BASE_URL, traps: input.traps ?? true });
  const rows = jobKeyboard(item.candidate.jobId, text).inline_keyboard;
  const buttons = rows
    .map((row) => `<div class="row">${row.map((b) => `<span class="btn">${escapeText(b.text)}</span>`).join("")}</div>`)
    .join("");
  const html = `<!doctype html>
<html lang="${text.locale}">
<head>
<meta charset="utf-8">
<title>${escapeText(input.caption)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #dfe6ee; font: 15px/1.45 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; }
  .phone { width: 430px; background: #c9d6e3; border-radius: 28px; padding: 18px 14px 22px; box-shadow: 0 10px 40px rgba(0,0,0,.15); }
  .caption { text-align: center; font-size: 12px; color: #4a5a6a; margin: 0 0 12px; letter-spacing: .02em; }
  .from { font-size: 13px; font-weight: 600; color: #2b6cb0; margin-bottom: 4px; }
  .bubble { background: #fff; border-radius: 14px 14px 14px 4px; padding: 10px 12px 6px; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
  .message { white-space: pre-wrap; word-wrap: break-word; }
  .message a { color: #2b6cb0; text-decoration: none; }
  .time { text-align: right; font-size: 11px; color: #8a96a3; margin-top: 2px; }
  .keyboard { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 6px; }
  .btn { flex: 1; text-align: center; background: rgba(255,255,255,.55); border-radius: 10px; padding: 8px 6px; font-size: 14px; color: #1f3b57; }
</style>
</head>
<body>
  <div class="phone">
    <p class="caption">${escapeText(input.caption)}</p>
    <div class="bubble">
      <div class="from">${escapeText(input.botName)}</div>
      <div class="message" data-testid="telegram-message">${message}</div>
      <div class="time">${escapeText(input.time)}</div>
    </div>
    <div class="keyboard">${buttons}</div>
  </div>
</body>
</html>`;
  return { message, html };
}
