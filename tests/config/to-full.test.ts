import { describe, expect, it } from "vitest";

import { parseConfigText } from "@/lib/config";
import { mergeLayers } from "@/lib/config/merge";
import { currentConfigVersion } from "@/lib/config/migrations/version";
import { replaceRule } from "@/lib/config/overlay-rules";
import { toFull, toFullText } from "@/lib/config/to-full";

import { effective, fixtureText, migratedDocument, overlay, overlayDocument, plainValue } from "./overlay-helpers";

describe("toFull", () => {
  it("lays the overlay over the shipped document; the current loader reads it as the merged value", () => {
    const shipped = migratedDocument("ai", fixtureText("ai"));
    const text = "translation:\n  glossary:\n    Solutions Engineer: !unset # not translated\n    Staff Engineer: Staff-Ingenieur\nscoring:\n  language_penalty:\n    B2: 0\n";
    const full = toFullText("ai", shipped, overlayDocument(text));
    expect(full).not.toContain("!unset");
    expect(full).toContain("Staff Engineer: Staff-Ingenieur");
    const expected = effective("ai", mergeLayers(plainValue(shipped), overlay(text), { replaceAt: replaceRule("ai") }));
    expect(parseConfigText("ai", full)).toEqual(expected);
  });

  it("keeps the shipped comments and the overlay's comments, and stamps the code's config_version", () => {
    const shipped = migratedDocument("schedule", "# head\ntimezone: UTC # shipped zone\nbackup:\n  # how many\n  keep_daily: 14\n");
    const full = toFullText("schedule", shipped, overlayDocument("backup:\n  keep_daily: 3 # mine\n"));
    expect(full).toContain("# head");
    expect(full).toContain("timezone: UTC # shipped zone");
    expect(full).toContain("# how many");
    expect(full).toContain("keep_daily: 3 # mine");
    expect(full).toMatch(new RegExp(`^# head\\nconfig_version: ${currentConfigVersion("schedule")}\\n`));
  });

  it("does not write keys that only the schema's defaults fill in", () => {
    const text = fixtureText("schedule").replace(/^control_poll_seconds:.*$/m, "");
    const shipped = migratedDocument("schedule", text);
    const full = toFullText("schedule", shipped, null);
    expect(full).not.toMatch(/^control_poll_seconds:/m);
    // a key the user wrote in the overlay stays, even when it equals the default
    expect(toFullText("schedule", shipped, overlayDocument("control_poll_seconds: 5\n"))).toMatch(/^control_poll_seconds: 5$/m);
  });

  it("replaces a whole record and a list as a whole, drops markers inside a replacing value", () => {
    const shipped = migratedDocument("search", fixtureText("search"));
    const doc = toFull("search", shipped, overlayDocument("keyword_groups:\n  mine:\n    - Staff Engineer\n"));
    expect((doc.toJS() as { keyword_groups: unknown }).keyword_groups).toEqual({ mine: ["Staff Engineer"] });
    const scalar = migratedDocument("schedule", "timezone: UTC\n");
    expect(toFull("schedule", scalar, overlayDocument("timezone:\n  a: !unset\n  b: 1\n")).toJS()).toMatchObject({ timezone: { b: 1 } });
  });

  it("changes neither input", () => {
    const shipped = migratedDocument("schedule", "timezone: UTC\n");
    const top = overlayDocument("timezone: Asia/Tokyo\nextra: !unset\n");
    const before = [shipped.toString(), top.toString()];
    toFull("schedule", shipped, top);
    expect([shipped.toString(), top.toString()]).toEqual(before);
  });
});
