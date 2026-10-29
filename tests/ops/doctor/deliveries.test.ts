// @vitest-environment node
import { describe, expect, it } from "vitest";

import { deliveryCheck } from "@/lib/ops/doctor/checks/deliveries";

import { makeContext, only } from "./helpers";

describe("delivery ledger health", () => {
  it.each([0, 99, 100])("is ok at %i bytes up to the threshold", async (bytes) => {
    const result = await only(deliveryCheck, makeContext({ locale: "en", probes: { deliveries: async () => ({ state: "ok", bytes, warnBytes: 100 }) } }));
    expect(result.status).toBe("ok");
    expect(result.detail).toContain(String(bytes));
  });

  it("warns above the threshold with a retention hint", async () => {
    const result = await only(deliveryCheck, makeContext({ locale: "en", probes: { deliveries: async () => ({ state: "ok", bytes: 101, warnBytes: 100 }) } }));
    expect(result.status).toBe("warn");
    expect(result.hint).toContain("retention.days");
    expect(result.hint).toContain("delivery-audit.yaml");
  });

  it("treats tables not set up yet as ok", async () => {
    const result = await only(deliveryCheck, makeContext({ locale: "en", probes: { deliveries: async () => ({ state: "ok", bytes: null, warnBytes: 100 }) } }));
    expect(result).toMatchObject({ status: "ok", detail: expect.stringContaining("not set up yet") });
  });

  it("reports unreadable config and database without exposing database errors", async () => {
    const config = await only(deliveryCheck, makeContext({ probes: { deliveries: async () => ({ state: "config_error", problem: "retention.days" }) } }));
    expect(config.status).toBe("warn");
    const ctx = makeContext({ probes: { deliveries: async () => { throw new Error("private receipt"); } } });
    const { runDoctor } = await import("@/lib/ops/doctor/run");
    const report = await runDoctor(ctx, [deliveryCheck]);
    expect(report.checks[0]?.status).toBe("warn");
    expect(JSON.stringify(report)).not.toContain("private receipt");
  });
});
