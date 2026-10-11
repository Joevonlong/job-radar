// @vitest-environment node
import { describe, expect, it } from "vitest";

import { pickApplyTarget, targetPlaceNames } from "@/lib/dashboard/apply";
import type { JobSourceRef } from "@/lib/db/queries/types";

const source = (locationLabel: string | null, priority: number, url = `https://x.test/${locationLabel ?? "none"}`): JobSourceRef => ({
  channelId: "c",
  family: "ats",
  url,
  applyUrl: null,
  locationLabel,
  priority,
});

const places = targetPlaceNames(
  { locations: ["Berlin", "München"] },
  { city_aliases: { Berlin: [], München: ["Munich", "Muenchen"] }, metro_areas: { München: ["Garching"] } },
);

describe("pickApplyTarget", () => {
  it("keeps the best priority when no place is wanted or none matches", () => {
    const list = [source("Amsterdam", 2), source("London", 1)];
    expect(pickApplyTarget(list)?.locationLabel).toBe("London");
    expect(pickApplyTarget(list, places)?.locationLabel).toBe("London");
  });

  it("prefers a source in a wanted city over a better-priority one elsewhere", () => {
    const list = [source("Amsterdam", 1), source("Berlin; Munich", 3), source("Munich", 2)];
    expect(pickApplyTarget(list, places)?.locationLabel).toBe("Munich");
    expect(pickApplyTarget([source("Amsterdam", 1), source("Garching bei München", 5)], places)?.locationLabel).toBe("Garching bei München");
  });

  it("ignores sources without a link", () => {
    expect(pickApplyTarget([source("Berlin", 1, null as unknown as string), source("Amsterdam", 2)], places)?.locationLabel).toBe("Amsterdam");
  });
});
