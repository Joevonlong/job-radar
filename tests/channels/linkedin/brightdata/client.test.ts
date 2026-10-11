// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError } from "@/lib/channels/errors";
import { BrightDataClient, buildDiscoveryInputs, parseSnapshotBody } from "@/lib/channels/linkedin/brightdata";
import type { ChannelContext } from "@/lib/channels/types";

import { ENV, SNAPSHOT_ID, berlinQuery, brightSettings, fakeProvider, harness, makeChannel, response, type FakeProvider } from "./helpers";
import { fixtureMarket } from "../../../pipeline/helpers";

const RECORD = { url: "https://www.linkedin.com/jobs/view/1", job_posting_id: "1", job_title: "t", company_name: "c" };

async function setup(provider: FakeProvider, overrides: { pollIntervalMs?: number; timeoutMs?: number } = {}) {
  const { ctx, warnings } = await harness(makeChannel(), provider);
  // a fake clock the fake sleep advances
  let clock = 0;
  const sleeps: number[] = [];
  const client = new BrightDataClient({
    ctx,
    apiKey: ENV.BRIGHT_DATA_API_KEY,
    datasetId: "gd_test",
    pollIntervalMs: overrides.pollIntervalMs ?? 1000,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const inputs = buildDiscoveryInputs(berlinQuery(), {
    ...brightSettings().extra,
  } as Parameters<typeof buildDiscoveryInputs>[1], fixtureMarket());
  return { client, inputs, sleeps, warnings, ctx: ctx as ChannelContext };
}

describe("trigger -> progress -> snapshot", () => {
  it("returns the delivered items once the snapshot is ready", async () => {
    const provider = fakeProvider({ records: [RECORD, { error: "x" }] });
    const { client, inputs, sleeps } = await setup(provider);
    const snapshot = await client.run(inputs, 10);
    expect(snapshot).toEqual({ snapshotId: SNAPSHOT_ID, items: [RECORD, { error: "x" }] });
    expect(provider.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /datasets/v3/trigger",
      `GET /datasets/v3/progress/${SNAPSHOT_ID}`,
      `GET /datasets/v3/snapshot/${SNAPSHOT_ID}`,
    ]);
    expect(sleeps).toEqual([]);
  });

  it("sends the documented trigger request: dataset, discover-by-keyword, limit, fields, bearer key, input array", async () => {
    const provider = fakeProvider({ records: [] });
    const { client, inputs } = await setup(provider);
    await client.run(inputs, 7);
    const [trigger, progress, snapshot] = provider.requests;
    expect(trigger?.query.get("dataset_id")).toBe("gd_test");
    expect(trigger?.query.get("type")).toBe("discover_new");
    expect(trigger?.query.get("discover_by")).toBe("keyword");
    expect(trigger?.query.get("limit_per_input")).toBe("7");
    expect(trigger?.query.get("include_errors")).toBe("true");
    expect(trigger?.query.get("custom_output_fields")).toContain("job_posting_id|job_title");
    expect(trigger?.headers.Authorization).toBe(`Bearer ${ENV.BRIGHT_DATA_API_KEY}`);
    expect(trigger?.body).toEqual(inputs);
    expect(snapshot?.query.get("format")).toBe("json");
    expect(new URL(trigger?.url ?? "").origin).toBe("https://api.brightdata.com");
    expect(progress?.headers.Authorization).toBe(`Bearer ${ENV.BRIGHT_DATA_API_KEY}`);
  });

  it("polls through starting / running / unknown statuses until ready", async () => {
    const provider = fakeProvider({ progress: ["starting", "running", "digesting", "ready"], records: [RECORD] });
    const { client, inputs, sleeps } = await setup(provider);
    expect((await client.run(inputs, 10)).items).toEqual([RECORD]);
    expect(provider.count("progress")).toBe(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it("keeps waiting while the download answers 202 (not ready) or 409", async () => {
    const provider = fakeProvider({ snapshotFirst: [response(202, { status: "building" }), response(409, "")], records: [RECORD] });
    const { client, inputs } = await setup(provider);
    expect((await client.run(inputs, 10)).items).toEqual([RECORD]);
    expect(provider.count("snapshot")).toBe(3);
  });

  it("times out when the snapshot never becomes ready (retryable network error)", async () => {
    const provider = fakeProvider({ progress: ["running"] });
    const { client, inputs, sleeps, warnings } = await setup(provider, { pollIntervalMs: 1000, timeoutMs: 5000 });
    const error = await client.run(inputs, 10).catch((e: unknown) => e);
    // the snapshot id is logged (warn) and in the error, so the snapshot can be fetched later
    expect(warnings).toEqual([{ message: "bright data snapshot timed out", fields: { snapshotId: SNAPSHOT_ID, timeoutMs: 5000 } }]);
    expect((error as Error).message).toContain(SNAPSHOT_ID);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "network", retryable: true });
    expect((error as Error).message).toContain("5000");
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000]); // waited the full 5000 ms
    expect(provider.count("snapshot")).toBe(0);
  });

  it.each(["failed", "canceled"])("a %s snapshot is a non-retryable failure", async (status) => {
    const provider = fakeProvider({ progress: ["running", status] });
    const { client, inputs } = await setup(provider);
    await expect(client.run(inputs, 10)).rejects.toMatchObject({ code: "unknown", retryable: false });
    expect(provider.count("snapshot")).toBe(0);
  });

  it("maps 402 to a budget error, 401 to auth_expired and 403 to blocked", async () => {
    const budget = await setup(fakeProvider({ trigger: response(402, "") }));
    await expect(budget.client.run(budget.inputs, 10)).rejects.toBeInstanceOf(BudgetExceededError);

    const auth = await setup(fakeProvider({ trigger: response(401, "") }));
    await expect(auth.client.run(auth.inputs, 10)).rejects.toMatchObject({ code: "auth_expired" });

    const blocked = await setup(fakeProvider({ trigger: response(403, "") }));
    await expect(blocked.client.run(blocked.inputs, 10)).rejects.toMatchObject({ code: "blocked" });

    const midway = await setup(fakeProvider({ progress: [response(402, "")] }));
    await expect(midway.client.run(midway.inputs, 10)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("never retries the trigger (a repeated trigger could bill twice), but retries progress polls", async () => {
    const flaky = fakeProvider({ trigger: response(500, "") });
    const a = await setup(flaky);
    await expect(a.client.run(a.inputs, 10)).rejects.toMatchObject({ code: "network" });
    expect(flaky.count("trigger")).toBe(1);

    const limited = fakeProvider({ trigger: response(429, "") });
    const b = await setup(limited);
    await expect(b.client.run(b.inputs, 10)).rejects.toMatchObject({ code: "rate_limited" });
    expect(limited.count("trigger")).toBe(1);

    const progress = fakeProvider({ progress: [response(503, ""), response(503, ""), "ready"], records: [RECORD] });
    const c = await setup(progress);
    expect((await c.client.run(c.inputs, 10)).items).toEqual([RECORD]);
    expect(progress.count("progress")).toBe(3);
  });

  it("rejects a trigger response without a valid snapshot id (never builds a URL from it)", async () => {
    for (const body of [{}, { snapshot_id: "../../etc" }, { snapshot_id: "" }, "not json"]) {
      const provider = fakeProvider({ trigger: response(200, body) });
      const { client, inputs } = await setup(provider);
      await expect(client.run(inputs, 10)).rejects.toMatchObject({ code: "parse" });
      expect(provider.count("progress")).toBe(0);
    }
  });

  it("rejects a progress response without a status", async () => {
    const provider = fakeProvider({ progress: [response(200, { nope: true })] });
    const { client, inputs } = await setup(provider);
    await expect(client.run(inputs, 10)).rejects.toMatchObject({ code: "parse" });
  });

  it("stops polling when the cycle is cancelled", async () => {
    const provider = fakeProvider({ progress: ["running"] });
    const { inputs, ctx } = await setup(provider);
    const controller = new AbortController();
    const cancelled = new BrightDataClient({
      ctx: { ...ctx, signal: controller.signal },
      apiKey: "k",
      datasetId: "gd_test",
      pollIntervalMs: 1000,
      timeoutMs: 100_000,
      sleep: async () => controller.abort(),
      now: () => 0,
    });
    await expect(cancelled.run(inputs, 10)).rejects.toThrow();
  });
});

describe("parseSnapshotBody", () => {
  it("accepts a JSON array, a single object, NDJSON and an empty body", () => {
    expect(parseSnapshotBody('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseSnapshotBody('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseSnapshotBody('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseSnapshotBody("  ")).toEqual([]);
  });

  it("raises a parse error for anything else", () => {
    expect(() => parseSnapshotBody("<html>nope</html>")).toThrow(ChannelError);
  });
});
