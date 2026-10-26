// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { discoverMonidEndpoints, inspectMonidEndpoint } from "../../../../scripts/smoke-monid";
import apiRuns from "../../../fixtures/monid/api-runs.json";
import { harness, response, settings } from "./helpers";

const configured = { provider: "apify", endpoint: "/harvestapi/linkedin-job-search", price: apiRuns.accepted.price };

describe("Monid smoke diagnostics", () => {
  it("discovers each LinkedIn job endpoint independently across price types, then inspects each", async () => {
    const matches = [
      { ...configured, extra: "Synthetic catalog metadata" },
      { provider: "synthetic-call", endpoint: "/linkedin/jobs-search-call", price: { type: "PER_CALL", amount: { value: 0.02, currency: "USD" } } },
      { provider: "synthetic-matrix", endpoint: "/linkedin/jobs-search-matrix", price: { type: "PER_UNIT_MATRIX", matrix: { standard: 0.01 } } },
      { provider: "synthetic-tiered", endpoint: "/linkedin/jobs-search-tiered", price: { type: "TIERED", tiers: [{ from: 0, amount: { value: 0.01, currency: "USD" } }] } },
    ];
    const results: unknown[] = [
      null, { provider: "unknown" }, { ...configured, price: null }, { ...configured, price: { type: 17 } },
      { ...configured, endpoint: "/linkedin/profile-search" }, { ...configured, endpoint: "/other/jobs-search" },
      { ...configured, price: { type: "PER_RESULT", amount: { value: 0.001, currency: "EUR" } } },
      ...matches,
    ];
    const h = await harness([response(200, { results }), ...matches.map((entry) => response(200, { price: entry.price, stoppable: true, extra: true }))]);
    const options = { http: h.ctx.http, settings: settings(), headers: {}, print: vi.fn(), warn: vi.fn() };
    expect(await discoverMonidEndpoints(options)).toBe(matches.length);
    expect(h.requests.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/v1/discover"], ...matches.map(() => ["POST", "/v1/inspect"]),
    ]);
    expect(h.requests.slice(1).map((request) => request.body)).toEqual(matches.map(({ provider, endpoint }) => ({ provider, endpoint })));
    for (const entry of matches) expect(options.print).toHaveBeenCalledWith(expect.objectContaining({
      provider: entry.provider, endpoint: entry.endpoint, priceType: entry.price.type,
    }));
    expect(options.print).toHaveBeenCalledWith(expect.objectContaining({
      ...configured, priceType: "PER_RESULT", amount: configured.price.amount, flatFee: configured.price.flatFee,
    }));
    expect(options.warn).not.toHaveBeenCalled();
  });

  it("inspects the configured endpoint even when discovery has no matching entries", async () => {
    const h = await harness([response(200, { results: [null, { extra: true }] }), response(200, { price: configured.price })]);
    const options = { http: h.ctx.http, settings: settings({ flat_fee_usd: 0 }), headers: {}, print: vi.fn(), warn: vi.fn() };
    expect(await discoverMonidEndpoints(options)).toBe(0);
    expect(h.requests[1]?.body).toEqual({ provider: configured.provider, endpoint: configured.endpoint });
    expect(options.warn).toHaveBeenCalledOnce();
  });

  it.each([
    { price_per_1k_usd: 2 }, { price_per_1k_usd: 0.5 }, { flat_fee_usd: 0.002 }, { flat_fee_usd: 0 },
  ])("warns when configured USD pricing differs from the inspected configured endpoint: %j", async (override) => {
    const h = await harness([response(200, { price: { ...configured.price, extra: true }, stoppable: true })]);
    const block = settings(override);
    const options = { http: h.ctx.http, settings: block, headers: {}, print: vi.fn(), warn: vi.fn() };
    await inspectMonidEndpoint(options, block.provider, block.endpoint);
    expect(options.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      configured: { price_per_1k_usd: block.price_per_1k_usd, flat_fee_usd: block.flat_fee_usd },
      inspected: { price_per_1k_usd: 1, flat_fee_usd: 0.001 },
    }));
  });

  it("treats an absent flat fee as zero when comparing prices", async () => {
    const h = await harness([response(200, { price: { ...configured.price, flatFee: undefined } })]);
    const options = { http: h.ctx.http, settings: settings({ flat_fee_usd: 0 }), headers: {}, print: vi.fn(), warn: vi.fn() };
    await inspectMonidEndpoint(options, configured.provider, configured.endpoint);
    expect(options.warn).not.toHaveBeenCalled();
  });

  it("does not compare another provider's price with the configured endpoint", async () => {
    const h = await harness([response(200, { price: configured.price })]);
    const options = { http: h.ctx.http, settings: settings({ price_per_1k_usd: 2 }), headers: {}, print: vi.fn(), warn: vi.fn() };
    await inspectMonidEndpoint(options, "synthetic-other", configured.endpoint);
    expect(options.warn).not.toHaveBeenCalled();
  });

  it.each([
    { type: "PER_RESULT", amount: { value: 2, currency: "EUR" } },
    { type: "PER_RESULT", amount: configured.price.amount, flatFee: { value: 2, currency: "EUR" } },
    { type: "PER_UNIT_MATRIX", matrix: {} },
  ])("warns instead of interpreting an unsupported inspected price as USD per result: %j", async (price) => {
    const h = await harness([response(200, { price })]);
    const options = { http: h.ctx.http, settings: settings(), headers: {}, print: vi.fn(), warn: vi.fn() };
    await inspectMonidEndpoint(options, configured.provider, configured.endpoint);
    expect(options.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      warning: "Monid inspected price is not a supported USD per-result price",
    }));
    expect(options.warn.mock.calls[0]?.[0]).not.toHaveProperty("inspected");
  });
});
