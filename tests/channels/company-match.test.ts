// @vitest-environment node
import { expect, it } from "vitest";
import { keepCompanyMatches } from "@/lib/channels/company-match";
import { createFixtureChannel } from "@/lib/channels/fixture";
import { loadPipeline } from "@/lib/market";

it("keeps matching keys and parse failures; rejects mentions, subsidiaries, and unrelated employers", () => {
  const fixture = createFixtureChannel({ postings: [] });
  const channel = { ...fixture, parse: (payload: unknown) => {
    if (payload === "broken") throw new Error("bad payload");
    return { title: "Works with Acme", companyName: String(payload), description: "Acme customer team", workplace: "onsite" as const, locations: [], applyUrl: null, sourceUrl: null };
  } };
  const names = ["Acme GmbH", "OTHER", "broken", "Acme Germany GmbH", "Agency", "Not Acme", "Acme Products", "Vendor"];
  const records = names.map((payload) => ({ externalId: payload, url: null, payload }));
  const result = keepCompanyMatches(records, channel, new Set(["acme", "other"]), loadPipeline());
  expect(result.kept.map((r) => r.payload)).toEqual(names.slice(0, 3));
  expect(result.dropped).toBe(5);
  expect(result.droppedNames).toEqual(names.slice(3, 6));
});
