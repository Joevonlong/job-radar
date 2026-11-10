// @vitest-environment node
/** Two remote scopes Apify sends as one location are one paid run; scopes it sends to different locations stay two. */
import { describe, expect, it } from "vitest";

import { buildQueries, queriesForChannels } from "@/lib/channels/query";
import type { ChannelsConfig } from "@/lib/config";

import { shippedSearch, testPlaces } from "../../helpers";
import { apifyConfig, apifySettings, fakeApify, harness, makeChannel } from "./helpers";

const places = testPlaces({ home_city: "Berlin", places: [{ place: "eu", relocate: false }, { place: "CH", relocate: false }], workplace: ["remote"] });
const queries = buildQueries(shippedSearch(), places, "manual");
const scopeQueries = queries.filter((query) => query.remote && query.location === null);
const groups = Object.keys(shippedSearch().keyword_groups).length;

/** Runs the queries the unit keeps through the channel against a fake Apify; returns the kept queries and the actor inputs sent. */
async function run(config: ChannelsConfig) {
  const channel = makeChannel();
  const kept = queriesForChannels(queries, [{ channel, settings: apifySettings(config) }]);
  const apify = fakeApify();
  const { ctx } = await harness(channel, apify, { config });
  for (const query of kept) await channel.collect(query, ctx);
  const remoteBodies = apify.requests.map((request) => request.body).filter((body) => body.location !== "Berlin, Germany");
  return { kept, remoteBodies };
}

describe("one Apify run per distinct actor input", () => {
  it("merges two scopes that `remote_locations.region` sends to the same place", async () => {
    expect(scopeQueries).toHaveLength(2 * groups);
    const { kept, remoteBodies } = await run(apifyConfig((apify) => void (apify.remote_locations = { region: "Europe" })));
    expect(kept.filter((query) => query.remote)).toHaveLength(groups);
    expect(remoteBodies.length).toBeGreaterThanOrEqual(groups);
    expect(remoteBodies.every((body) => body.location === "Europe")).toBe(true);
    // no actor input is sent twice
    expect(new Set(remoteBodies.map((body) => JSON.stringify(body))).size).toBe(remoteBodies.length);
  });

  it("keeps two scopes that go to different places", async () => {
    const shared = await run(apifyConfig((apify) => void (apify.remote_locations = { region: "Europe" })));
    const { kept, remoteBodies } = await run(apifyConfig((apify) => void (apify.remote_locations = {})));
    expect(kept).toEqual(queries);
    expect(remoteBodies).toHaveLength(2 * shared.remoteBodies.length);
    expect(new Set(remoteBodies.map((body) => JSON.stringify(body))).size).toBe(remoteBodies.length);
    expect(new Set(remoteBodies.map((body) => body.location))).toEqual(new Set(["European Union", "Switzerland"]));
  });
});
