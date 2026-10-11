// @vitest-environment node
/** The doctor's `config.market` check. */
import { describe, expect, it } from "vitest";

import { configMarketCheck } from "@/lib/ops/doctor/checks/config";
import type { MarketSummaryResult } from "@/lib/market/summary";

import { makeContext, marketSummary, only } from "./helpers";

const check = (result: MarketSummaryResult) => only(configMarketCheck, makeContext({ probes: { market: async () => result } }));

describe("config.market", () => {
  it("names the market when it resolves", async () => {
    const result = await check(marketSummary());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("xx：DE，EUR，本地语言 de（语言步骤开）");
  });

  it("fails with the reason and a fix when the market cannot be resolved", async () => {
    const result = await check({ ok: false, reason: 'market pack "nowhere" not found' });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain('market pack "nowhere" not found');
    expect(result.hint).toContain("pnpm market:show");
  });

  it("warns about a user copy of the pack and a market without running channels", async () => {
    const result = await check(marketSummary({ packLayer: "user", channels: { running: [], localOff: ["board-a"], otherMarket: [{ id: "board-b", markets: ["FR"] }] } }));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("/defaults/packs/xx");
    expect(result.detail).toContain("board-b");
  });
});
