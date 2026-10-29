import { describe, expect, it } from "vitest";
import { reasonCodeSchema } from "@/lib/activity/names";
import { stepActivityOutcome } from "@/lib/cycle/step-activity";
import type { StepResult } from "@/lib/cycle/steps";

describe("step activity outcome", () => {
  it.each(["quota_guard", "no_provider_available", "disabled", "no_database", "not_configured", "no_request"])("records an explicit %s skip without changing the outcome", (reason) => {
    const outcome: StepResult = { status: "partial", result: { skipped: reason, delegated: true } };
    const before = structuredClone(outcome);
    const [status, code] = stepActivityOutcome(outcome);
    expect(status).toBe("skipped");
    expect(code).toBe(reason);
    expect(reasonCodeSchema.parse(code)).toBe(reason);
    expect(outcome).toEqual(before);
  });

  it("replaces an unknown skip reason with the closed fallback code", () => {
    expect(stepActivityOutcome({ result: { skipped: "private https://private.test" } })).toEqual(["skipped", "other"]);
    expect(reasonCodeSchema.parse("other")).toBe("other");
  });

  it.each([undefined, 0, 3, false, { filteredOut: 2 }])("does not mistake skip counts for a whole-step skip: %j", (skipped) => {
    expect(stepActivityOutcome({ result: { skipped } })).toEqual(["ok"]);
  });

  it("preserves ordinary, delegated and failed outcomes", () => {
    expect(stepActivityOutcome()).toEqual(["ok"]);
    expect(stepActivityOutcome({ status: "partial" })).toEqual(["partial"]);
    expect(stepActivityOutcome({ result: { delegated: true } })).toEqual(["skipped", "delegated"]);
    expect(stepActivityOutcome({ status: "failed", result: { delegated: true } })).toEqual(["failed"]);
  });
});
