// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  calculateRunCost,
  acceptedRunSchema,
  billingSchema,
  dollarCostSchema,
  errorForResponse,
  errorResponseSchema,
  isTerminal,
  microDollarCostSchema,
  monidSettingsSchema,
  runResponseSchema,
  stopAcceptedSchema,
  stopConflictSchema,
  validateFinalInput,
  type MonidRun,
} from "@/lib/channels/linkedin/monid/contract";

import responses from "../../../fixtures/monid/responses.json";
import { settings } from "./helpers";

const pricing = { price_per_1k_usd: 1, flat_fee_usd: 0.001 };
const micro = (value: number) => ({ value, unit: "MICRO_DOLLAR", currency: "USD" });
const cost = (fields: Record<string, unknown> = {}, status: MonidRun["status"] = "COMPLETED", count = 2) =>
  calculateRunCost({ status, output: Array.from({ length: count }, () => ({})), ...fields }, 10, pricing);

describe("Monid billing", () => {
  it("takes the maximum settled value, retaining zeros and excluding calculatedCost", () => {
    expect(cost({ billing: { actualCost: micro(0), reportedCost: micro(3000) } }).costUsd).toBe(0.003);
    expect(cost({ billing: { actualCost: micro(0), reportedCost: micro(0), calculatedCost: micro(3000) } }).costUsd).toBe(0);
    expect(cost({ cost: { value: 0.02, currency: "USD" }, billing: { actualCost: micro(5000) } }).costUsd).toBe(0.02);
    expect(cost({ cost: { value: 0, currency: "USD" } }).costUsd).toBe(0);
  });

  it("uses calculatedCost only without settled fields, and requests a warning", () => {
    expect(cost({ billing: { calculatedCost: micro(4000) } })).toMatchObject({ costUsd: 0.004, source: "calculated" });
  });

  it.each([
    { cost: { value: 0.2, currency: "EUR" } },
    { cost: 0.2 },
    { billing: { actualCost: { value: 100, unit: "DOLLAR", currency: "USD" } } },
    { billing: { reportedCost: { value: 100, unit: "MICRO_DOLLAR", currency: "EUR" } } },
    { billing: { calculatedCost: -1 } },
    { billing: "invalid" },
  ])("estimates on malformed billing without trusting an unknown unit: %j", (fields) => {
    expect(cost(fields, "FAILED")).toMatchObject({ costUsd: 0.011, source: "estimate", invalidFields: expect.any(Array) });
    expect(cost(fields, "FAILED").invalidFields.length).toBeGreaterThan(0);
  });

  it.each([
    [{ cost: { value: 0.2, currency: "EUR" }, billing: { reportedCost: micro(4000) } }, 0.004, "cost"],
    [{ cost: { value: 0.004, currency: "USD" }, billing: "invalid" }, 0.004, "billing"],
    [{ billing: { actualCost: "invalid", reportedCost: micro(4000) } }, 0.004, "billing.actualCost"],
    [{ billing: { reportedCost: "invalid", actualCost: micro(0) } }, 0, "billing.reportedCost"],
    [{ billing: { reportedCost: micro(100), calculatedCost: "invalid" } }, 0.0001, "billing.calculatedCost"],
  ] as const)("keeps valid settlements despite an invalid sibling field: %j", (fields, usd, invalid) => {
    expect(cost(fields, "FAILED")).toMatchObject({ costUsd: usd, source: "settled", invalidFields: [invalid] });
  });

  it("uses valid calculated cost when all provided settled fields are invalid", () => {
    expect(cost({ cost: -1, billing: { actualCost: "invalid", calculatedCost: micro(4000) } }, "FAILED"))
      .toMatchObject({ costUsd: 0.004, source: "calculated", invalidFields: ["cost", "billing.actualCost"] });
  });

  it("estimates from billed units before delivered count or terminal-state fallback", () => {
    expect(cost({ billedUnits: 5 })).toMatchObject({ costUsd: 0.006, units: 5 });
    expect(cost({ billedUnits: 0 }, "FAILED")).toMatchObject({ costUsd: 0.001, units: 0 });
    expect(cost()).toMatchObject({ costUsd: 0.003, units: 2 });
    expect(cost({}, "COMPLETED", 0).costUsd).toBe(0.001);
    for (const status of ["FAILED", "TIMED_OUT"] as const) {
      expect(cost({}, status)).toMatchObject({ costUsd: 0.011, conservative: true });
    }
    for (const status of ["BLOCKED", "STOPPED"] as const) expect(cost({}, status).costUsd).toBe(0);
  });

  it("uses the limit when a successful provider response has no countable output or usable billing", () => {
    expect(cost({ providerResponse: { httpStatus: 200 }, output: {} }))
      .toMatchObject({ costUsd: 0.011, source: "estimate", conservative: true });
    expect(cost({ providerResponse: { httpStatus: 200 }, output: {}, billedUnits: 2 }))
      .toMatchObject({ costUsd: 0.003, units: 2 });
  });
});

describe("Monid response classification", () => {
  it("validates accepted, synchronous, blocked, poll, stop and error response contracts", () => {
    expect(acceptedRunSchema.safeParse(responses.accepted).success).toBe(true);
    expect(acceptedRunSchema.safeParse({ runId: "run_example" }).success).toBe(true);
    for (const body of [responses.completed, responses.blocked, responses.running, responses.stopped]) {
      expect(runResponseSchema.safeParse(body).success).toBe(true);
    }
    expect(stopAcceptedSchema.safeParse(responses.stopping).success).toBe(true);
    expect(stopConflictSchema.safeParse(responses.conflict).success).toBe(true);
    expect(errorResponseSchema.safeParse(responses.error).success).toBe(true);
    expect(acceptedRunSchema.safeParse({ runId: "../../unsafe" }).success).toBe(false);
    expect(runResponseSchema.safeParse({ status: null }).success).toBe(false);
    expect(stopAcceptedSchema.safeParse({}).success).toBe(false);
    expect(errorResponseSchema.safeParse({}).success).toBe(false);
    expect(billingSchema.safeParse(responses.completed.billing).success).toBe(true);
    expect(dollarCostSchema.safeParse({ value: 0, currency: "USD" }).success).toBe(true);
    expect(microDollarCostSchema.safeParse(micro(0)).success).toBe(true);
    expect(billingSchema.safeParse({ actualCost: 3000 }).success).toBe(false);
  });
  it.each([
    [200, { status: "COMPLETED", providerResponse: { httpStatus: 200 } }, null, false],
    [200, { status: "COMPLETED", providerResponse: { httpStatus: 404 } }, null, false],
    [200, { status: "COMPLETED", providerResponse: { httpStatus: 429 } }, "rate_limited", true],
    [200, { status: "COMPLETED", providerResponse: { httpStatus: 400 } }, "unknown", false],
    [200, { status: "COMPLETED", providerResponse: { httpStatus: 503 } }, "network", true],
    [200, { status: "FAILED" }, "network", true],
    [200, { status: "TIMED_OUT" }, "network", true],
    [200, { status: "BLOCKED" }, "budget_exceeded", false],
    [402, {}, "budget_exceeded", false],
    [503, {}, "budget_exceeded", false],
    [401, {}, "auth_expired", false],
    [403, {}, "blocked", false],
    [502, {}, "unknown", false],
    [404, {}, "unknown", false],
    [408, {}, "network", true],
    [429, {}, "rate_limited", true],
  ] as const)("maps HTTP %i and %j", (status, body, code, retryable) => {
    const error = errorForResponse(status, body);
    if (code === null) expect(error).toBeNull();
    else expect(error).toMatchObject({ code, retryable });
  });

  it("reads the run status before the transport status", () => {
    expect(errorForResponse(502, { status: "BLOCKED" })).toMatchObject({ code: "budget_exceeded", tripsCircuit: false });
    expect(errorForResponse(503, { status: "COMPLETED", providerResponse: { httpStatus: 200 } })).toBeNull();
  });

  it.each(["READY", "RUNNING", "STOPPING", "COMPLETED", "FAILED", "TIMED_OUT", "BLOCKED", "STOPPED"])("accepts only documented run statuses: %s", (status) => {
    expect(runResponseSchema.safeParse({ status }).success).toBe(true);
    expect(acceptedRunSchema.safeParse({ runId: "run_example", status }).success).toBe(true);
  });

  it("does not classify an unknown status as a run or a terminal state", () => {
    expect(runResponseSchema.safeParse({ status: "error" }).success).toBe(false);
    expect(acceptedRunSchema.safeParse({ runId: "run_example", status: "error" }).success).toBe(false);
    expect(isTerminal("error")).toBe(false);
    expect(errorForResponse(402, { status: "error" })).toMatchObject({ code: "budget_exceeded" });
    expect(errorForResponse(200, { status: "error" })).toMatchObject({ code: "parse" });
  });
});

describe("Monid input safety", () => {
  const valid = { jobTitles: ["Engineer"], locations: ["Example City"], maxItems: 10 };
  it("allows one title and location with the exact positive limit", () => {
    expect(() => validateFinalInput(valid, 10)).not.toThrow();
  });
  it.each([
    { jobTitles: ["A", "B"] }, { jobTitles: [] }, { jobTitles: [""] },
    { locations: ["A", "B"] }, { locations: [" "] }, { maxItems: 0 }, { maxItems: 9 }, { maxItems: "10" },
  ])("refuses a billable input with %j", (override) => {
    expect(() => validateFinalInput({ ...valid, ...override }, 10)).toThrow(expect.objectContaining({ code: "unknown", retryable: false }));
  });

  it("requires configuration instead of hard-coding actor or price defaults", () => {
    expect(monidSettingsSchema.safeParse({ surprise: true }).success).toBe(false);
  });

  it.each([0, -1])("rejects a nonpositive per-result price: %s", (price) => {
    expect(monidSettingsSchema.safeParse({ ...settings(), price_per_1k_usd: price }).success).toBe(false);
  });

  it("allows a zero flat fee with a positive per-result price", () => {
    expect(monidSettingsSchema.safeParse({ ...settings(), flat_fee_usd: 0 }).success).toBe(true);
  });
});
