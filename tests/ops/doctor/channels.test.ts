// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { budgetChecks, channelsCheck, linkedinCheck, missingEnv } from "@/lib/ops/doctor/checks/channels";
import type { CheckResult } from "@/lib/ops/doctor";

import { ago, channelState, makeContext, only, results, sourcesView } from "./helpers";
import { CHANNEL_CONFIG_TABLE } from "@/lib/channels/registry";

const view = (extra: Parameters<typeof sourcesView>[0] = {}, edit?: Parameters<typeof sourcesView>[1]) => ({ probes: { sources: async () => sourcesView(extra, edit) } });
const states = (patch: Record<string, Partial<ReturnType<typeof channelState>>>) => Object.keys(CHANNEL_CONFIG_TABLE).map((id) => channelState(id, patch[id] ?? {}));
const byId = (list: CheckResult[]) => new Map(list.map((r) => [r.id, r]));

describe("channels.each", () => {
  it("one ok line per enabled channel, one line for the closed ones", async () => {
    const list = byId(await results(channelsCheck, makeContext()));
    expect(list.get("channels.indeed")?.status).toBe("ok");
    expect(list.get("channels.linkedin-brightdata")?.status).toBe("ok");
    expect(list.get("channels.disabled")?.detail).toContain("linkedin-session");
    expect(list.has("channels.jsearch")).toBe(false);
    for (const r of list.values()) expect(r.status).toBe("ok");
  });

  it("warns for an enabled channel whose key is missing and names the variable, not a value", async () => {
    const ctx = makeContext({ env: { TAVILY_API_KEY: "", APIFY_TOKEN: undefined } });
    const list = byId(await results(channelsCheck, ctx));
    expect(list.get("channels.tavily")).toMatchObject({ status: "warn", detail: expect.stringContaining("TAVILY_API_KEY") });
    expect(list.get("channels.linkedin-apify")?.detail).toContain("APIFY_TOKEN");
    expect(list.get("channels.tavily")?.hint).toContain(".env");
    expect(list.get("channels.indeed")?.status).toBe("ok");
  });

  it("knows the key variables of every channel that needs one", () => {
    const ctx = makeContext({ env: { BRIGHT_DATA_API_KEY: "", JSEARCH_API_KEY: "", GMAIL_USER: "", GMAIL_APP_PASSWORD: "x" } });
    expect(missingEnv(ctx, "linkedin-brightdata")).toEqual(["BRIGHT_DATA_API_KEY"]);
    expect(missingEnv(ctx, "jsearch")).toEqual(["JSEARCH_API_KEY"]);
    expect(missingEnv(ctx, "gmail-alerts")).toEqual(["GMAIL_USER"]);
    expect(missingEnv(ctx, "indeed")).toEqual([]);
  });

  it("warns on an open circuit with the error code and the retry time", async () => {
    const open = states({ indeed: { circuitState: "open", circuitOpenUntil: new Date("2026-10-08T00:00:00Z"), consecutiveFailures: 3, lastErrorCode: "blocked" } });
    const list = byId(await results(channelsCheck, makeContext(view({ states: open }))));
    expect(list.get("channels.indeed")).toMatchObject({ status: "warn" });
    expect(list.get("channels.indeed")?.detail).toContain("熔断中（连续失败 3 次");
    expect(list.get("channels.indeed")?.detail).toContain("blocked");
    expect(list.get("channels.lever")?.status).toBe("ok");
  });

  it("a circuit past its cooldown is half open, not a problem", async () => {
    const half = states({ indeed: { circuitState: "open", circuitOpenUntil: ago(60), consecutiveFailures: 3 } });
    const list = byId(await results(channelsCheck, makeContext(view({ states: half }))));
    expect(list.get("channels.indeed")).toMatchObject({ status: "ok", detail: expect.stringContaining("试探") });
  });

  it("warns when the channel has no row (not implemented or the runner never ran)", async () => {
    const list = byId(await results(channelsCheck, makeContext(view({ states: states({}).filter((s) => s.id !== "xing") }, (raw) => ((raw.sources as Record<string, { enabled: boolean }>).xing.enabled = true)))));
    expect(list.get("channels.xing")).toMatchObject({ status: "warn", detail: expect.stringContaining("没有登记") });
  });

  it("warns when every request of the last cycle failed", async () => {
    const latestCycle = { id: 1, kind: "weekday_morning" as const, status: "partial" as const, startedAt: ago(3600), finishedAt: ago(3000), channels: [{ channelId: "lever", family: "lever", runs: 2, succeeded: 0, failed: 2, skipped: 0, fetched: 0 }] };
    const list = byId(await results(channelsCheck, makeContext(view({ latestCycle }))));
    expect(list.get("channels.lever")).toMatchObject({ status: "warn", detail: expect.stringContaining("全部失败") });
  });

  it("budget: ok below 80 %, warns from 80 %, fails when used up", async () => {
    const usage = (usd: number) => new Map([["linkedin-apify", { records: 10, usd }]]);
    const at = async (usd: number) => byId(await results(channelsCheck, makeContext(view({ usage: usage(usd) })))).get("channels.linkedin-apify");
    expect((await at(7.9))?.status).toBe("ok"); // of $10
    const warn = await at(8);
    expect(warn).toMatchObject({ status: "warn", detail: expect.stringContaining("$8.00 / $10.00（80%）") });
    const full = await at(10);
    expect(full).toMatchObject({ status: "fail", detail: expect.stringContaining("已用完") });
  });

  it("budget thresholds come from notify.yaml", async () => {
    const usage = new Map([["linkedin-apify", { records: 10, usd: 6 }]]);
    const ctx = makeContext({ ...view({ usage }), notify: (raw) => ((raw.alerts as Record<string, unknown>).budget_thresholds = [0.5, 1]) });
    expect(byId(await results(channelsCheck, ctx)).get("channels.linkedin-apify")?.status).toBe("warn");
  });

  it("free allowance: shows usage, warns near the end and past it", async () => {
    const at = async (records: number) => byId(await results(channelsCheck, makeContext(view({ usage: new Map([["linkedin-brightdata", { records, usd: 0 }]]) })))).get("channels.linkedin-brightdata");
    expect(await at(225)).toMatchObject({ status: "ok", detail: expect.stringContaining("免费额度 225 / 5000 条") });
    expect((await at(4000))?.status).toBe("warn");
    expect(await at(5200)).toMatchObject({ status: "warn", detail: expect.stringContaining("已用完") });
  });

  it("fails when no channel is enabled at all", async () => {
    const off = (raw: Record<string, unknown>) => {
      const l = raw.linkedin as Record<string, { enabled?: boolean }>;
      for (const k of ["brightdata", "apify", "session", "guest"]) (l[k] as { enabled: boolean }).enabled = false;
      for (const v of Object.values(raw.sources as Record<string, { enabled?: boolean }>)) if ("enabled" in v) v.enabled = false;
      for (const k of ["indeed", "arbeitsagentur", "stepstone", "xing", "jsearch"]) {
        const section = (raw.sources as Record<string, { enabled: boolean }>)[k];
        if (section) section.enabled = false;
      }
    };
    const list = await results(channelsCheck, makeContext(view({}, off)));
    expect(list.find((r) => r.id === "channels.enabled")).toMatchObject({ status: "fail" });
  });
});

describe("channels.linkedin", () => {
  it("ok with a usable cascade; the session login is optional while disabled", async () => {
    const r = await only(linkedinCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("linkedin-brightdata → linkedin-apify → linkedin-session → linkedin-guest");
    expect(r.detail).toContain("未启用，可选");
  });
  it("fails when nothing in the cascade is usable", async () => {
    const ctx = makeContext({ env: { BRIGHT_DATA_API_KEY: "", APIFY_TOKEN: "" }, ...view({ states: states({ "linkedin-guest": { circuitState: "open", circuitOpenUntil: new Date("2026-10-08T00:00:00Z") } }) }) });
    const r = await only(linkedinCheck, ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("都不能运行");
  });
  it("is not a failure when no LinkedIn channel is set up: the paid ones lack keys and the free ones are off", async () => {
    const guestOff = (raw: Record<string, unknown>) => ((raw.linkedin as { guest: { enabled: boolean } }).guest.enabled = false);
    const ctx = makeContext({ channels: guestOff, env: { BRIGHT_DATA_API_KEY: "", APIFY_TOKEN: "" }, ...view({}, guestOff) });
    const r = await only(linkedinCheck, ctx);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("没有设置好的通道");
  });
  it("one key missing is not a failure while another channel carries the cascade", async () => {
    expect((await only(linkedinCheck, makeContext({ env: { BRIGHT_DATA_API_KEY: "" } }))).status).toBe("ok");
  });
  it("session enabled: needs a login file in the auth dir", async () => {
    const enable = { channels: (raw: Record<string, unknown>) => ((raw.linkedin as { session: { enabled: boolean } }).session.enabled = true) };
    const without = await only(linkedinCheck, makeContext({ ...enable, ...view({}, enable.channels) }));
    expect(without.status).toBe("warn");
    expect(without.detail).toContain(".auth/");
    const ctx = makeContext({ ...enable, ...view({}, enable.channels), probes: { listDir: vi.fn(async () => [".gitkeep", "linkedin.json"]), sources: async () => sourcesView({}, enable.channels) } });
    const withFile = await only(linkedinCheck, ctx);
    expect(withFile.status).toBe("ok");
    expect(ctx.probes.listDir).toHaveBeenCalledWith("/Volumes/SSD/work/job-radar/.auth");
  });
});

describe("budget.paid and budget.ai_api", () => {
  it("ok at zero spend", async () => {
    const list = byId(await results(budgetChecks, makeContext()));
    expect(list.get("budget.paid")).toMatchObject({ status: "ok", detail: "本月合计 $0.00 / $15.00（0%）" });
    expect(list.get("budget.ai_api")?.detail).toContain("$0.00 / $10.00");
  });
  it("warns at 80 % of the total cap and fails at 100 %", async () => {
    const at = async (usage: Map<string, { records: number; usd: number }>) => byId(await results(budgetChecks, makeContext(view({ usage })))).get("budget.paid");
    expect((await at(new Map([["linkedin-apify", { records: 1, usd: 12 }]])))?.status).toBe("warn");
    expect((await at(new Map([["linkedin-apify", { records: 1, usd: 15 }]])))?.status).toBe("fail");
  });
  it("AI API spend against ai.yaml monthly_api_budget_usd", async () => {
    const list = byId(await results(budgetChecks, makeContext(view({ apiSpendUsd: 9 }))));
    expect(list.get("budget.ai_api")).toMatchObject({ status: "warn", detail: expect.stringContaining("$9.00 / $10.00（90%）") });
  });
  it("a zero cap with spend is a failure", async () => {
    const list = byId(await results(budgetChecks, makeContext(view({ apiSpendUsd: 1, aiConfig: { monthly_api_budget_usd: 0 } }))));
    expect(list.get("budget.ai_api")?.status).toBe("fail");
  });
});
