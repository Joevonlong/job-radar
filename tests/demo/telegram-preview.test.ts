import { describe, expect, it } from "vitest";

import { renderTelegramPreview } from "../../e2e-demo/telegram-preview";

import { formatJobMessage } from "@/lib/notify/format";
import type { PushItem } from "@/lib/notify/select";
import { notifyText } from "@/lib/notify/text";

import { candidate } from "../notify/helpers";

describe("Telegram message preview", () => {
  it("shows exactly formatJobMessage's output, with dashboard links on 127.0.0.1:3000", () => {
    const c = candidate({});
    const item: PushItem = { candidate: c, watched: false, rank: c.score?.rankValue ?? null, reason: "threshold" };
    const text = notifyText("en");
    const preview = renderTelegramPreview(item, text, { caption: "Message format preview (demo data)", botName: "Job Radar", time: "10:00" });
    expect(preview.message).toBe(formatJobMessage(item, text, { publicBaseUrl: "http://127.0.0.1:3000", traps: true }));
    expect(preview.message).toContain('href="http://127.0.0.1:3000/jobs/');
    expect(preview.html).toContain(preview.message);
    expect(preview.html).toContain("Message format preview (demo data)");
  });
});
