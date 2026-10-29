// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cascadeSkipReasons } from "@/lib/cycle/collect";

describe("cascade activity reasons", () => {
  it.each(["budget_exceeded", "circuit_open", "not_registered", "not_configured", "disabled"])("keeps a common %s reason", (reason) => {
    expect(cascadeSkipReasons({ first: reason, second: reason })).toEqual({ reasonCode: reason, perChannel: { first: reason, second: reason } });
  });
  it("preserves each channel when reasons differ", () => {
    expect(cascadeSkipReasons({ first: "budget_exceeded", second: "circuit_open" })).toEqual({ reasonCode: "mixed", perChannel: { first: "budget_exceeded", second: "circuit_open" } });
  });
  it("unwraps safe failures of this cycle and rejects unknown reasons", () => {
    expect(cascadeSkipReasons({ first: "failed_this_cycle:auth" })).toEqual({ reasonCode: "auth", perChannel: { first: "auth" } });
    expect(cascadeSkipReasons({ first: "failed_this_cycle:https://private.test", second: "private text" })).toEqual({ reasonCode: "other", perChannel: { first: "other", second: "other" } });
    expect(cascadeSkipReasons({})).toEqual({ reasonCode: "other", perChannel: {} });
  });
});
