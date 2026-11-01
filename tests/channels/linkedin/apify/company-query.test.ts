// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ENV, berlinQuery, fakeApify, harness, makeChannel } from "./helpers";

describe("Apify company query without searchable text", () => {
  it("is skipped without a run, an error or a spent result", async () => {
    const apify = fakeApify();
    const channel = makeChannel({ environment: ENV });
    const { ctx, warnings } = await harness(channel, apify);
    const query = berlinQuery({ keywords: ['""'], keywordGroup: "company:x", location: null, company: { name: '""', key: "x" } });
    await expect(channel.collect(query, ctx)).resolves.toEqual([]);
    expect(apify.requests).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});
