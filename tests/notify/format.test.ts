import { describe, expect, it } from "vitest";

import { decodeCallback } from "@/lib/notify/callbacks";
import {
  badgesOf,
  cycleLabel,
  escapeHtml,
  escapeHtmlAttribute,
  fitLines,
  formatAlert,
  formatJobMessage,
  formatReminders,
  formatSummary,
  jobKeyboard,
  link,
  salaryRangeText,
  MAX_MESSAGE_CHARS,
  truncate,
} from "@/lib/notify/format";
import type { PushItem } from "@/lib/notify/select";
import { buildCatalog } from "@/lib/signals/catalog";

import { rawCategories, shippedInterests } from "../signals/helpers";

import { candidate, salary } from "./helpers";
import { notifyText } from "@/lib/notify/text";

const ZH = notifyText("zh");

const item = (overrides: Parameters<typeof candidate>[0] = {}, extra: Partial<PushItem> = {}): PushItem => {
  const c = candidate(overrides);
  return { candidate: c, watched: false, rank: c.score?.rankValue ?? null, reason: "threshold", ...extra };
};

/** Every `<` in the output starts one of the tags we emit; text content never leaks a raw tag. */
function tagNames(html: string): string[] {
  return [...html.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1] as string);
}

describe("escapeHtml", () => {
  it("escapes the three characters Telegram HTML needs", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes & first, so an entity in the source is shown literally and never double-decoded", () => {
    expect(escapeHtml("&amp; &lt;")).toBe("&amp;amp; &amp;lt;");
  });

  it("neutralises injected markup in job titles", () => {
    const evil = '</b><a href="https://evil.test">click</a><script>x</script>';
    const escaped = escapeHtml(evil);
    expect(escaped).not.toMatch(/[<>]/);
    expect(escaped).toBe("&lt;/b&gt;&lt;a href=\"https://evil.test\"&gt;click&lt;/a&gt;&lt;script&gt;x&lt;/script&gt;");
  });

  it("leaves everything MarkdownV2 would need escaped untouched", () => {
    const plain = "_*[]()~`#+-=|{}.!\\ . - ( ) ! + = #";
    expect(escapeHtml(plain)).toBe(plain);
  });

  it("keeps unicode, emoji and newlines", () => {
    expect(escapeHtml("Müller & Söhne — 数据 🚀\nzeile 2")).toBe("Müller &amp; Söhne — 数据 🚀\nzeile 2");
  });

  it("escapes quotes only in attribute values", () => {
    expect(escapeHtml('say "hi"')).toBe('say "hi"');
    expect(escapeHtmlAttribute('x" onclick="y')).toBe("x&quot; onclick=&quot;y");
  });
});

describe("link", () => {
  it("builds an anchor with escaped label and URL", () => {
    expect(link("A & B", 'https://x.test/?a=1&b="2"')).toBe('<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">A &amp; B</a>');
  });

  it("falls back to the plain label for a non-http(s) or very long URL", () => {
    expect(link("x", "javascript:alert(1)")).toBe("x");
    expect(link("x", `https://x.test/${"a".repeat(2000)}`)).toBe("x");
  });
});

describe("truncate", () => {
  it("cuts by code points, never inside an emoji, and adds an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("🚀🚀🚀🚀", 3)).toBe("🚀🚀…");
    expect(truncate("abc", 3)).toBe("abc");
  });
});

describe("formatJobMessage", () => {
  const base = { publicBaseUrl: "https://radar.example-tailnet.ts.net/" };

  it("lays out rank with breakdown, badges, title, company, place, summary and links", () => {
    const text = formatJobMessage(
      item({ jobId: 7, title: "Senior ML Engineer", rank: 82, match: 75, signalBonus: 7, signalTiers: ["T1", "T2", "T3", "T4", "tag"], salary: salary(85000, 105000), germanLevelRequired: "B2", sourceUrl: "https://boards.example.test/7?x=1&y=2" }, { watched: true }),
      ZH,
      base,
    );
    expect(text.split("\n")).toEqual([
      "<b>🎯 82</b> <i>（匹配 75 + 信号 7）</i>  💰 €85–105k · 📈 股权 · 🏅 有竞争力 · 🎁 奖金 · 👀 关注 · 需德语 B2",
      "<b>Senior ML Engineer</b>",
      "Acme GmbH · Berlin · Hybrid",
      "一句话摘要",
      '<a href="https://radar.example-tailnet.ts.net/jobs/7">打开详情</a> · <a href="https://boards.example.test/7?x=1&amp;y=2">原链接</a>',
    ]);
  });

  it("only carries the original link when no public_base_url is configured", () => {
    const text = formatJobMessage(item({ jobId: 7 }), ZH, { publicBaseUrl: null });
    expect(text).toContain('<a href="https://jobs.example.test/7">原链接</a>');
    expect(text).not.toContain("打开详情");
  });

  it("omits the signal part without a bonus, the German badge for none/unknown, and shows 未评分 for an unscored watched job", () => {
    const plain = formatJobMessage(item({ rank: 71, match: 71, signalBonus: 0 }), ZH, base);
    expect(plain.split("\n")[0]).toBe("<b>🎯 71</b> <i>（匹配 71）</i>");
    expect(formatJobMessage(item({ germanLevelRequired: "unknown" }), ZH, base)).not.toContain("需德语");
    expect(formatJobMessage(item({ germanLevelRequired: "preferred" }), ZH, base)).not.toContain("需德语");
    // The badge names the market's local language, and is gone while the language step is off
    expect(formatJobMessage(item({ germanLevelRequired: "B2" }), ZH, { ...base, languageName: "法语" })).toContain("需法语 B2");
    expect(formatJobMessage(item({ germanLevelRequired: "B2" }), ZH, { ...base, languageName: null })).not.toContain("需");
    const unscored = formatJobMessage(item({ unscored: true }, { watched: true, rank: null }), ZH, base);
    expect(unscored.split("\n")[0]).toBe("<b>未评分</b>  👀 关注");
  });

  it("rounds fractional ranks to one decimal", () => {
    expect(formatJobMessage(item({ rank: 81.25, match: 74.5, signalBonus: 6.75 }), ZH, base).split("\n")[0]).toContain("🎯 81.3");
  });

  it("escapes every piece of free text", () => {
    const text = formatJobMessage(
      item({ title: "R&D <Lead> *senior*", companyName: "A<B> & Söhne", locations: ["Frankfurt (Oder)"] }),
      ZH,
      { publicBaseUrl: null },
    );
    expect(text).toContain("<b>R&amp;D &lt;Lead&gt; *senior*</b>");
    expect(text).toContain("A&lt;B&gt; &amp; Söhne · Frankfurt (Oder) · Hybrid");
    expect(tagNames(text).every((t) => ["b", "i", "a"].includes(t))).toBe(true);
  });

  it("keeps long fields within one message and on one line", () => {
    const text = formatJobMessage(item({ title: `${"x ".repeat(400)}\n\n`, companyName: "c".repeat(500) }), ZH, base);
    expect(text.length).toBeLessThan(MAX_MESSAGE_CHARS);
    expect(text.split("\n")[1]?.startsWith("<b>")).toBe(true);
  });

  it("appends the marked line and escapes it", () => {
    expect(formatJobMessage(item(), ZH, { publicBaseUrl: null, markedLine: "👍 已标记：感兴趣" }).endsWith("\n\n👍 已标记：感兴趣")).toBe(true);
  });

  it("shows up to three places and how many more, plus Remote", () => {
    const text = formatJobMessage(item({ locations: ["Berlin", "Hamburg", "München", "Köln"], workplace: "remote" }), ZH, { publicBaseUrl: null });
    expect(text).toContain("Acme GmbH · Berlin / Hamburg / München +1 · Remote");
  });
});

describe("badgesOf", () => {
  it("maps T1 → 💰 range, T2 → 📈, T3 → 🏅, T4 → 🎁 and a watched company → 👀; benefit tags are not badges", () => {
    expect(badgesOf({ candidate: candidate({ signalTiers: ["tag"] }), watched: false }, ZH)).toEqual([]);
    expect(badgesOf({ candidate: candidate({ signalTiers: ["T3"] }), watched: false }, ZH)).toEqual(["🏅 有竞争力"]);
    expect(badgesOf({ candidate: candidate({ signalTiers: ["tag", "T4", "T2", "T1"], salary: salary(90000, 90000) }), watched: true }, ZH)).toEqual([
      "💰 €90k",
      "📈 股权",
      "🎁 奖金",
      "👀 关注",
    ]);
  });

  it("says when the salary is possibly another region's pay", () => {
    const usd = salary(137600, 172000, { currency: "USD", otherRegion: "currency" });
    expect(badgesOf({ candidate: candidate({ signalTiers: ["T1"], salary: usd }), watched: false }, ZH)).toEqual(["💰 €137.6–172k（可能是其他地区的薪资）"]);
  });

  it("shows 💰 alone when the T1 signal has no usable normalized salary", () => {
    expect(badgesOf({ candidate: candidate({ signalTiers: ["T1"] }), watched: false }, ZH)).toEqual(["💰"]);
    expect(badgesOf({ candidate: candidate({ signalTiers: ["T1"], salary: salary(85000, 105000, { qualityStatus: "review" }) }), watched: false }, ZH)).toEqual(["💰"]);
  });

  it("follows the categories (order, icon + Chinese name, English when there is none) and leaves out deleted ones", () => {
    const interests = shippedInterests((raw) => {
      const categories = rawCategories(raw);
      categories.unshift({ id: "visa", kind: "keyword", label: { en: "Visa sponsorship" }, icon: "🛂", color: "violet", ai_definition: "visa", keywords: ["visa"] });
      categories.push({ id: "remote", kind: "keyword", label: { zh: "远程预算" }, color: "olive", ai_definition: "remote budget", keywords: ["remote budget"] });
      const [t3] = categories.splice(categories.findIndex((c) => c.id === "T3"), 1);
      (raw.signals as { retired_categories: unknown[] }).retired_categories = [t3];
    });
    const catalog = buildCatalog(interests);
    expect(badgesOf({ candidate: candidate({ signalTiers: ["remote", "T3", "T2", "visa"] }), watched: false }, ZH, { catalog })).toEqual(["🛂 Visa sponsorship", "📈 股权", "远程预算"]);
    expect(badgesOf({ candidate: candidate({ signalTiers: ["T2"] }), watched: true }, ZH, { catalog: null })).toEqual(["👀 关注"]);
  });
});

describe("salaryRangeText", () => {
  it("formats the yearly range in thousands", () => {
    expect(salaryRangeText(salary(85000, 105000))).toBe("€85–105k");
    expect(salaryRangeText(salary(87500, 92500))).toBe("€87.5–92.5k");
    expect(salaryRangeText(salary(null, 120000))).toBe("≤ €120k");
    expect(salaryRangeText(salary(70000, null))).toBe("≥ €70k");
    expect(salaryRangeText(salary(60000, 60000))).toBe("€60k");
  });

  it("uses the posting's own currency when there is no EUR conversion, and nothing when there is no range", () => {
    expect(salaryRangeText(salary(100000, 120000, { currency: "USD", eurPerYear: null }))).toBe("$100–120k");
    expect(salaryRangeText(salary(100000, 120000, { currency: "SEK", eurPerYear: null }))).toBe("SEK 100–120k");
    expect(salaryRangeText(salary(null, null))).toBeNull();
    expect(salaryRangeText(null)).toBeNull();
  });
});

describe("jobKeyboard", () => {
  it("has the three status buttons with compact, decodable callback data", () => {
    const [row] = jobKeyboard(1234567, ZH).inline_keyboard;
    expect(row?.map((b) => b.text)).toEqual(["👍 感兴趣", "🚫 忽略", "📄 定制简历"]);
    expect(row?.map((b) => decodeCallback(b.callback_data))).toEqual([
      { jobId: 1234567, action: "interested" },
      { jobId: 1234567, action: "ignore" },
      { jobId: 1234567, action: "resume" },
    ]);
    expect(row?.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
  });
});

describe("jobKeyboard without a resume-kit folder", () => {
  it("leaves out the résumé button", () => {
    const [row] = jobKeyboard(5, ZH, { resumeKit: false }).inline_keyboard;
    expect(row?.map((b) => decodeCallback(b.callback_data)?.action)).toEqual(["interested", "ignore"]);
  });
});

describe("jobKeyboard hidden statuses", () => {
  it("leaves out the buttons whose target status is hidden", () => {
    const [row] = jobKeyboard(5, ZH, { hiddenStatuses: ["interested", "preparing"] }).inline_keyboard;
    expect(row?.map((b) => decodeCallback(b.callback_data)?.action)).toEqual(["ignore"]);
    const [only] = jobKeyboard(5, ZH, { hiddenStatuses: ["preparing"] }).inline_keyboard;
    expect(only?.map((b) => decodeCallback(b.callback_data)?.action)).toEqual(["interested", "ignore"]);
  });
});

describe("jobKeyboard favorite row", () => {
  it("has a second row with the star: ⭐ 收藏 when not starred, ☆ 取消收藏 once starred", () => {
    const [, plain] = jobKeyboard(9, ZH).inline_keyboard;
    expect(plain?.map((b) => b.text)).toEqual(["⭐ 收藏"]);
    expect(plain?.map((b) => b.callback_data)).toEqual(["a:9:f"]);
    const [, starred] = jobKeyboard(9, ZH, { favorite: true }).inline_keyboard;
    expect(starred?.map((b) => b.text)).toEqual(["☆ 取消收藏"]);
    expect(starred?.map((b) => decodeCallback(b.callback_data))).toEqual([{ jobId: 9, action: "unfavorite" }]);
    expect(jobKeyboard(9, ZH).inline_keyboard).toHaveLength(2);
  });
});

describe("formatSummary", () => {
  const input = {
    cycleKind: "weekday_morning",
    at: new Date("2026-10-07T05:00:00Z"), // 07:00 in Berlin (CEST)
    timeZone: "Europe/Berlin",
    newJobs: 12,
    passedFilter: 9,
    qualified: 4,
    pushed: 3,
    overflow: 1,
    failedSources: [{ channelId: "linkedin-brightdata", reasons: ["rate_limited"] }, { channelId: "indeed", reasons: [] }],
    publicBaseUrl: "https://radar.example.test",
  };

  it("lists the cycle, the counts, the overflow, the failed sources and the dashboard link", () => {
    expect(formatSummary(input, ZH).split("\n")).toEqual([
      "<b>📡 早轮 · 10-07 07:00</b>",
      "新岗位 12 · 通过过滤 9 · 合格 4（本条之后推送 3 条）",
      "另有 1 条待推送岗位超过每轮上限，在看板里看。",
      "⚠️ 失败的来源：linkedin-brightdata（rate_limited）；indeed",
      '<a href="https://radar.example.test">打开看板</a>',
    ]);
  });

  it("is short when all is well", () => {
    const text = formatSummary({ ...input, cycleKind: "catchup", overflow: 0, failedSources: [], publicBaseUrl: null }, ZH);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("补跑轮");
  });

  it("escapes channel ids", () => {
    expect(formatSummary({ ...input, failedSources: [{ channelId: "a<b>", reasons: ["x&y"] }] }, ZH)).toContain("a&lt;b&gt;（x&amp;y）");
  });
});

describe("formatAlert", () => {
  it("has a bold title and an escaped detail", () => {
    expect(formatAlert("通道 a<b> 已熔断", "x & y")).toBe("🚨 <b>通道 a&lt;b&gt; 已熔断</b>\nx &amp; y");
  });
});

describe("formatReminders", () => {
  const now = new Date("2026-10-07T07:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("lists each non-empty section with ages and a remainder line", () => {
    const text = formatReminders({
      now,
      publicBaseUrl: "https://radar.example.test",
      sections: [
        { heading: "👍 感兴趣超过 7 天还没申请", total: 3, items: [{ jobId: 5, title: "ML <Eng>", companyName: "Acme & Co", statusChangedAt: ago(9.5) }] },
        { heading: "📨 已申请超过 14 天没有回音", total: 0, items: [] },
      ],
    }, ZH);
    expect(text.split("\n")).toEqual([
      "<b>📋 申请提醒</b>",
      "",
      "<b>👍 感兴趣超过 7 天还没申请</b>（3）",
      '• <a href="https://radar.example.test/jobs/5">ML &lt;Eng&gt;</a> — Acme &amp; Co（9 天）',
      "… 还有 2 条",
    ]);
  });

  it("never exceeds the message limit", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ jobId: i + 1, title: "T".repeat(80), companyName: "C".repeat(50), statusChangedAt: ago(10) }));
    const text = formatReminders({ now, publicBaseUrl: "https://radar.example.test", sections: [{ heading: "h", total: 60, items }] }, ZH);
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(text.endsWith("…（其余已省略）")).toBe(true);
  });
});

describe("fitLines", () => {
  it("returns the lines unchanged when they fit", () => {
    expect(fitLines(["a", "b"], ZH.t("omitted"))).toBe("a\nb");
  });
});

describe("AI trap badge", () => {
  it("puts the trap badge first, with ×N for several, only when traps are on", () => {
    expect(badgesOf({ candidate: candidate({ signalTiers: ["T3"], trapCount: 1 }), watched: false }, ZH, { traps: true })).toEqual(["🪤 AI 陷阱", "🏅 有竞争力"]);
    expect(badgesOf({ candidate: candidate({ signalTiers: [], trapCount: 3 }), watched: false }, ZH, { traps: true })).toEqual(["🪤 AI 陷阱 ×3"]);
    expect(badgesOf({ candidate: candidate({ signalTiers: [], trapCount: 3 }), watched: false }, ZH)).toEqual([]);
    expect(badgesOf({ candidate: candidate({ signalTiers: [], trapCount: 0 }), watched: false }, ZH, { traps: true })).toEqual([]);
  });

  it("shows it in the job message", () => {
    expect(formatJobMessage(item({ trapCount: 2 }), ZH, { publicBaseUrl: null, traps: true })).toContain("🪤 AI 陷阱 ×2");
    expect(formatJobMessage(item({ trapCount: 2 }), ZH, { publicBaseUrl: null })).not.toContain("🪤");
  });
});

describe("Telegram in English (notify.locale)", () => {
  const EN = notifyText("en");

  it("writes the job message, its badges and links in English", () => {
    const text = formatJobMessage(
      item({ jobId: 7, title: "Senior ML Engineer", rank: 82, match: 75, signalBonus: 7, signalTiers: ["T1", "T3"], salary: salary(85000, 105000), germanLevelRequired: "B2", trapCount: 1 }, { watched: true }),
      EN,
      { publicBaseUrl: "https://radar.example.test", traps: true },
    );
    const [first, , , , links] = text.split("\n");
    expect(first).toBe("<b>🎯 82</b> <i>(fit 75 + signals 7)</i>  🪤 AI trap · 💰 €85–105k · 🏅 Competitive · 👀 Watched · German B2 required");
    expect(links).toBe('<a href="https://radar.example.test/jobs/7">Open details</a> · <a href="https://jobs.example.test/7">Original posting</a>');
    expect(formatJobMessage(item({ unscored: true }, { rank: null }), EN, { publicBaseUrl: null }).split("\n")[0]).toBe("<b>Not scored</b>");
  });

  it("labels the buttons in English", () => {
    const [row, star] = jobKeyboard(3, EN, { favorite: true }).inline_keyboard;
    expect(row?.map((b) => b.text)).toEqual(["👍 Interested", "🚫 Ignore", "📄 Tailor résumé"]);
    expect(star?.map((b) => b.text)).toEqual(["☆ Unsave"]);
  });

  it("writes the run summary and the reminders in English", () => {
    const summary = formatSummary(
      { cycleKind: "weekday_evening", at: new Date("2026-10-07T16:00:00Z"), timeZone: "Europe/Berlin", newJobs: 12, passedFilter: 9, qualified: 4, pushed: 3, overflow: 2, failedSources: [{ channelId: "indeed", reasons: ["a", "b"] }], publicBaseUrl: null },
      EN,
    );
    expect(summary.split("\n")).toEqual([
      "<b>📡 Evening run · 10-07 18:00</b>",
      "New 12 · passed the filter 9 · qualified 4 (3 pushed after this message)",
      "2 more jobs to push went over the per-run limit: see the board.",
      "⚠️ Failed sources: indeed (a, b)",
    ]);
    const now = new Date("2026-10-07T07:00:00Z");
    const reminders = formatReminders(
      { now, publicBaseUrl: null, sections: [{ heading: EN.t("reminders.interested", { days: 7 }), total: 1, items: [{ jobId: 5, title: "ML", companyName: "Acme", statusChangedAt: new Date(now.getTime() - 86_400_000) }] }] },
      EN,
    );
    expect(reminders.split("\n")).toEqual(["<b>📋 Application reminders</b>", "", "<b>👍 Interested for more than 7 days, not applied yet</b> (1)", "• ML — Acme (1 day)"]);
  });

  it("names cycle kinds in the Telegram language and keeps unknown ones as they are", () => {
    expect(cycleLabel("weekend", EN)).toBe("Weekend run");
    expect(cycleLabel("weekend", ZH)).toBe("周末轮");
    expect(cycleLabel("something_new", EN)).toBe("something_new");
  });
});
