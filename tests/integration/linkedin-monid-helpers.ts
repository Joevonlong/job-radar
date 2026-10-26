import type { FetchLike } from "@/lib/channels/http";

import { channelsWith } from "../channels/helpers";
import jobs from "../fixtures/monid/harvestapi-jobs.json";

export const MONID = "linkedin-monid";
export const NOW = new Date("2026-10-26T12:00:00Z");
export const MONTH = "2026-10";
export const ENV = { MONID_API_KEY: "fake-monid-integration-key" };

export function monidChannels(options: { brightRecords?: number; apifyBudget?: number } = {}) {
  return channelsWith((raw) => {
    const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
    Object.assign(linkedin.brightdata!, { enabled: true, free_records_per_month: options.brightRecords ?? 0, monthly_budget_usd: 0 });
    Object.assign(linkedin.apify!, { enabled: true, monthly_budget_usd: options.apifyBudget ?? 0 });
    Object.assign(linkedin.monid!, {
      enabled: true, monthly_budget_usd: 1, max_results: 10, price_per_1k_usd: 1, flat_fee_usd: 0.001,
      poll_interval_ms: 1, timeout_ms: 1000, stop_grace_ms: 100, throttle: { min_delay_ms: 0, max_delay_ms: 0 },
    });
  });
}

export function monidJob(id: string): Record<string, unknown> {
  return { ...jobs[0], id, linkedinUrl: `https://www.linkedin.com/jobs/view/${id}` };
}

/** An asynchronous Monid transport; throws on every unexpected host or path instead of reaching the network. */
export function monidProvider(output?: unknown[]) {
  const requests: Array<{ method: string; path: string }> = [];
  let runs = 0;
  const fetch: FetchLike = async (url, init) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    requests.push({ method, path: target.pathname });
    if (target.host !== "api.monid.ai") throw new Error("Unexpected integration request host");
    let body: unknown;
    let status = 200;
    if (target.pathname === "/v1/run" && method === "POST") {
      runs += 1;
      status = 202;
      body = { runId: `run_test_${runs}`, status: "READY", price: { type: "PER_RESULT", amount: 0.001, flatFee: 0.001 } };
    } else if (target.pathname === `/v1/runs/run_test_${runs}` && method === "GET") {
      const items = output ?? [monidJob(String(4386000000 + runs))];
      const microDollars = (items.length + 1) * 1000;
      body = { runId: `run_test_${runs}`, status: "COMPLETED", providerResponse: { httpStatus: 200 }, output: items,
        billedUnits: items.length, billing: {
          calculatedCost: { value: microDollars, unit: "MICRO_DOLLAR", currency: "USD" },
          reportedCost: { value: microDollars, unit: "MICRO_DOLLAR", currency: "USD" },
          actualCost: { value: 0, unit: "MICRO_DOLLAR", currency: "USD" },
        } };
    } else throw new Error("Unexpected integration request path");
    const text = JSON.stringify(body);
    return { status, ok: true, headers: { get: () => null }, text: async () => text, json: async (): Promise<unknown> => JSON.parse(text) };
  };
  return { fetch, requests, runs: () => runs };
}
