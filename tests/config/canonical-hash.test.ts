import { describe, expect, it } from "vitest";

import { parseConfigText } from "@/lib/config";
import { canonicalConfigHash, canonicalConfigJson } from "@/lib/config/canonical-hash";

import { fixtureText, migratedDocument, overlayDocument } from "./overlay-helpers";

describe("canonical config hash", () => {
  it("does not depend on key order, comments or config_version", () => {
    const a = parseConfigText("schedule", fixtureText("schedule"));
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(canonicalConfigHash(reordered)).toBe(canonicalConfigHash(a));
    expect(canonicalConfigHash({ ...a, config_version: 7 })).toBe(canonicalConfigHash(a));
    const commented = fixtureText("schedule").replace(/^timezone:(.*)$/m, "# a new comment\ntimezone:$1 # and another");
    expect(canonicalConfigHash(parseConfigText("schedule", commented))).toBe(canonicalConfigHash(a));
    expect(canonicalConfigJson({ b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}],"b":{"c":2,"d":1}}');
  });

  it("changes with any leaf value", () => {
    const a = parseConfigText("schedule", fixtureText("schedule"));
    const base = canonicalConfigHash(a);
    expect(canonicalConfigHash({ ...a, timezone: "Asia/Tokyo" })).not.toBe(base);
    expect(canonicalConfigHash({ ...a, backup: { ...a.backup, keep_daily: a.backup.keep_daily + 1 } })).not.toBe(base);
    expect(canonicalConfigHash({ x: [1, 2] })).not.toBe(canonicalConfigHash({ x: [2, 1] }));
    expect(canonicalConfigHash({ x: null })).not.toBe(canonicalConfigHash({}));
    expect(canonicalConfigHash({ x: "1" })).not.toBe(canonicalConfigHash({ x: 1 }));
    // a nested config_version is a value like any other
    expect(canonicalConfigHash({ a: { config_version: 1 } })).not.toBe(canonicalConfigHash({ a: {} }));
  });

  it("hashes timestamp leaves by instant and keeps their type distinct", () => {
    const load = (since: string) => {
      const doc = migratedDocument("channels", fixtureText("channels"));
      doc.setIn(["linkedin", "apify", "input_template"], overlayDocument(`since: ${since}\n`).contents);
      return parseConfigText("channels", doc.toString());
    };
    const loaded = load("!!timestamp 2026-10-30");
    const date = new Date("2026-10-30T00:00:00.000Z");
    expect(loaded.linkedin.apify.input_template.since).toEqual(date);
    expect(canonicalConfigHash(loaded)).not.toBe(canonicalConfigHash(load("!!timestamp 2026-10-31")));
    expect(canonicalConfigHash(loaded)).not.toBe(canonicalConfigHash(load('"2026-10-30T00:00:00.000Z"')));
    const hash = (since: unknown) => canonicalConfigHash({ since });
    expect(hash(date)).toBe(hash(new Date(date)));
    expect(hash(date)).not.toBe(hash(new Date("2026-10-31T00:00:00.000Z")));
    expect(hash(date)).not.toBe(hash(date.toISOString()));
    expect(hash(date)).not.toBe(hash({ $type: "date", value: date.toISOString() }));
  });
});
