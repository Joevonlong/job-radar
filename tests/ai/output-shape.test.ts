import { describe, expect, it } from "vitest";

import { claudeOutputShape, codexOutputShape } from "@/lib/ai/providers/output-shape";

describe("passive look at the CLI output (names only, never values)", () => {
  it("keeps the key names of the claude envelope and its usage", () => {
    const stdout = JSON.stringify({ type: "result", result: "SECRET ANSWER", session_id: "abc-123", usage: { input_tokens: 5, output_tokens: 7, service_tier: "standard" }, total_cost_usd: 0.01 });
    const shape = claudeOutputShape(stdout);
    expect(shape).toEqual({ keys: ["result", "session_id", "total_cost_usd", "type", "usage"], usageKeys: ["input_tokens", "output_tokens", "service_tier"] });
    expect(JSON.stringify(shape)).not.toMatch(/SECRET|abc-123|standard/);
    expect(claudeOutputShape("not json")).toBeNull();
    expect(claudeOutputShape("[1,2]")).toBeNull();
  });

  it("lists the codex event and item types, the keys of unknown events and of turn.completed", () => {
    const lines = [
      { type: "thread.started", thread_id: "t-secret" },
      { type: "item.completed", item: { type: "agent_message", text: "SECRET ANSWER" } },
      { type: "rate_limits.updated", primary: { used_percent: 42 }, "weird key with spaces": 1 },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
    ].map((l) => JSON.stringify(l));
    const shape = codexOutputShape([...lines, "garbage", ""].join("\n"));
    expect(shape).toEqual({
      eventTypes: ["thread.started", "item.completed", "rate_limits.updated", "turn.completed"],
      unknownEvents: { "thread.started": ["thread_id", "type"], "rate_limits.updated": ["primary", "type"] },
      itemTypes: ["agent_message"],
      turnCompletedKeys: ["type", "usage"],
      turnUsageKeys: ["input_tokens", "output_tokens"],
    });
    expect(JSON.stringify(shape)).not.toMatch(/SECRET|t-secret|42/);
  });
});
