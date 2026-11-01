// @vitest-environment node
import { describe, expect, it } from "vitest";

import { hasSearchableKeywords } from "@/lib/channels/linkedin/brightdata";

import { berlinQuery, fakeProvider, harness, makeChannel } from "./helpers";

const company = (name: string) => berlinQuery({ keywords: [name], keywordGroup: `company:${name}`, location: null, company: { name, key: "key" } });

describe("Bright Data company query without searchable text", () => {
  it("knows a name of only quote characters has no keywords", () => {
    expect(hasSearchableKeywords(company('""'))).toBe(false);
    expect(hasSearchableKeywords(company("Acme"))).toBe(true);
  });

  it("is skipped without a request, an error or a spent record", async () => {
    const provider = fakeProvider({ records: [] });
    const channel = makeChannel();
    const { ctx, warnings } = await harness(channel, provider);
    await expect(channel.collect(company('"'), ctx)).resolves.toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});
