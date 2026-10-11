import { describe, expect, it } from "vitest";

import { pickRowLocations } from "@/lib/dashboard/row-locations";

const loc = (city: string, label = city) => ({ city, label });

describe("pickRowLocations", () => {
  const places = ["Berlin", "München", "Munich", "Garching"];

  it("puts the wanted cities first so they are not cut off, and counts the rest", () => {
    const result = pickRowLocations([loc("Tallinn"), loc("Dublin"), loc("London"), loc("Berlin")], places, 3);
    expect(result).toEqual({ shown: ["Berlin", "Tallinn", "Dublin"], more: 1 });
  });

  it("matches the label too and keeps the stored order inside each group", () => {
    const result = pickRowLocations([{ city: null, label: "Greater Munich" }, loc("Paris"), loc("Berlin")], places, 3);
    expect(result.shown).toEqual(["Greater Munich", "Berlin", "Paris"]);
    expect(result.more).toBe(0);
  });

  it("lists distinct places only", () => {
    expect(pickRowLocations([loc("Rome"), loc("Rome"), loc("Oslo")], places, 3)).toEqual({ shown: ["Rome", "Oslo"], more: 0 });
  });
});
