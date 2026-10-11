// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CascadeController, type UnavailableReason } from "@/lib/channels/cascade";
import { BudgetExceededError, ChannelError, InfrastructureError } from "@/lib/channels/errors";

const ORDER = ["linkedin-brightdata", "linkedin-apify", "linkedin-session", "linkedin-guest"] as const;

function controller(unavailable: Partial<Record<string, UnavailableReason>> = {}) {
  return new CascadeController(
    { family: "linkedin", order: ORDER },
    { availability: (id) => unavailable[id] ?? null },
  );
}

describe("CascadeController", () => {
  it("uses the first channel in the order when everything is available", async () => {
    const outcome = await controller().serve(async (id) => id);
    expect(outcome).toMatchObject({ status: "served", channelId: "linkedin-brightdata", value: "linkedin-brightdata", attempts: [] });
  });

  it("skips a channel that is over budget and uses the second", async () => {
    const outcome = await controller({ "linkedin-brightdata": "budget_exceeded" }).serve(async (id) => id);
    expect(outcome).toMatchObject({ status: "served", channelId: "linkedin-apify" });
  });

  it("skips over-budget and circuit-open channels down to the third", async () => {
    const outcome = await controller({ "linkedin-brightdata": "budget_exceeded", "linkedin-apify": "circuit_open" }).serve(async (id) => id);
    expect(outcome).toMatchObject({ status: "served", channelId: "linkedin-session" });
  });

  it("skips disabled and unregistered channels", async () => {
    const outcome = await controller({
      "linkedin-brightdata": "disabled",
      "linkedin-apify": "not_registered",
      "linkedin-session": "disabled",
    }).serve(async (id) => id);
    expect(outcome).toMatchObject({ status: "served", channelId: "linkedin-guest" });
  });

  it("reports skipped with a reason per channel when none is available", async () => {
    const outcome = await controller({
      "linkedin-brightdata": "budget_exceeded",
      "linkedin-apify": "disabled",
      "linkedin-session": "circuit_open",
      "linkedin-guest": "not_registered",
    }).serve(async (id) => id);
    expect(outcome).toEqual({
      status: "skipped",
      attempts: [],
      reasons: {
        "linkedin-brightdata": "budget_exceeded",
        "linkedin-apify": "disabled",
        "linkedin-session": "circuit_open",
        "linkedin-guest": "not_registered",
      },
    });
  });

  it("falls through on a budget error thrown by the channel and remembers it for the cycle", async () => {
    const c = controller();
    const tried: string[] = [];
    const first = await c.serve(async (id) => {
      tried.push(id);
      if (id === "linkedin-brightdata") throw new BudgetExceededError("channel", "no money");
      return id;
    });
    expect(first).toMatchObject({ status: "served", channelId: "linkedin-apify" });
    expect(first.status === "served" && first.attempts.map((a) => [a.channelId, a.error.code])).toEqual([
      ["linkedin-brightdata", "budget_exceeded"],
    ]);
    const second = await c.serve(async (id) => {
      tried.push(id);
      return id;
    });
    expect(second).toMatchObject({ status: "served", channelId: "linkedin-apify" });
    // brightdata was not tried again
    expect(tried).toEqual(["linkedin-brightdata", "linkedin-apify", "linkedin-apify"]);
    expect([...c.unusableChannels()]).toEqual([["linkedin-brightdata", "budget_exceeded"]]);
  });

  it("falls through on a non-retryable failure (blocked) for the same query", async () => {
    const c = controller();
    const outcome = await c.serve(async (id) => {
      if (id !== "linkedin-guest") throw new ChannelError("blocked", "captcha");
      return id;
    });
    expect(outcome).toMatchObject({ status: "served", channelId: "linkedin-guest" });
    expect(outcome.status === "served" && outcome.attempts).toHaveLength(3);
  });

  it("classifies plain errors as unknown and falls through", async () => {
    const outcome = await controller().serve(async (id) => {
      if (id === "linkedin-brightdata") throw new TypeError("bug");
      return id;
    });
    expect(outcome).toMatchObject({ status: "served", channelId: "linkedin-apify" });
    expect(outcome.status === "served" && outcome.attempts[0]?.error.code).toBe("unknown");
  });

  it("does not fall through on a retryable failure: the query fails, the channel stays usable", async () => {
    const c = controller();
    const outcome = await c.serve(async () => {
      throw new ChannelError("rate_limited", "429");
    });
    expect(outcome).toMatchObject({ status: "failed", channelId: "linkedin-brightdata" });
    expect(c.unusableChannels().size).toBe(0);
    const next = await c.serve(async (id) => id);
    expect(next).toMatchObject({ status: "served", channelId: "linkedin-brightdata" });
  });

  it("ends as skipped when every channel fails this cycle", async () => {
    const c = controller();
    const outcome = await c.serve(async () => {
      throw new ChannelError("auth_expired", "401");
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.status === "skipped" && Object.values(outcome.reasons)).toEqual(Array(4).fill("failed_this_cycle:auth_expired"));
    expect(outcome.attempts).toHaveLength(4);
  });

  it("re-checks availability for every query (a circuit can open between queries)", async () => {
    const state: Partial<Record<string, UnavailableReason>> = {};
    const c = new CascadeController({ family: "linkedin", order: ORDER }, { availability: (id) => state[id] ?? null });
    expect(await c.serve(async (id) => id)).toMatchObject({ channelId: "linkedin-brightdata" });
    state["linkedin-brightdata"] = "circuit_open";
    expect(await c.serve(async (id) => id)).toMatchObject({ channelId: "linkedin-apify" });
  });

  it("propagates cancellation and infrastructure errors untouched", async () => {
    await expect(controller().serve(async () => Promise.reject(new DOMException("x", "AbortError")))).rejects.toMatchObject({ name: "AbortError" });
    await expect(controller().serve(async () => Promise.reject(new InfrastructureError("db down")))).rejects.toBeInstanceOf(InfrastructureError);
  });
});
