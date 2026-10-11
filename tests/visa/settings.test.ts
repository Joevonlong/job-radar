// @vitest-environment node
import { describe, expect, it } from "vitest";

import { VISA_UI_DEFAULTS } from "@/lib/config/schemas/ui";
import { readNeedsVisaSponsorship, readVisaSettings, visaBadgesVisible } from "@/lib/visa/settings";

const fail = (): never => {
  throw new Error("cannot read");
};

describe("visa settings", () => {
  it("shows the badge and filter: always, never, or auto only for a user who needs sponsorship", () => {
    expect(visaBadgesVisible({ enabled: true, badges: "always" }, false)).toBe(true);
    expect(visaBadgesVisible({ enabled: true, badges: "always" }, true)).toBe(true);
    expect(visaBadgesVisible({ enabled: true, badges: "never" }, true)).toBe(false);
    expect(visaBadgesVisible({ enabled: true, badges: "auto" }, true)).toBe(true);
    expect(visaBadgesVisible({ enabled: true, badges: "auto" }, false)).toBe(false);
  });

  it("shows nothing while the check is off", () => {
    expect(visaBadgesVisible({ enabled: false, badges: "always" }, true)).toBe(false);
    expect(visaBadgesVisible({ enabled: false, badges: "auto" }, true)).toBe(false);
  });

  it("reads ui.yaml job_checks.visa, and the defaults when ui.yaml cannot be read", () => {
    expect(readVisaSettings(() => ({ job_checks: { closed_recheck: { enabled: true, extra_phrases: [] }, visa: { enabled: false, badges: "never" } } }))).toEqual({ enabled: false, badges: "never" });
    expect(readVisaSettings(fail)).toEqual(VISA_UI_DEFAULTS);
  });

  it("reads me.yaml needs_visa_sponsorship: only true counts, an unreadable file is false", () => {
    expect(readNeedsVisaSponsorship(() => ({ needs_visa_sponsorship: true }))).toBe(true);
    expect(readNeedsVisaSponsorship(() => ({ needs_visa_sponsorship: false }))).toBe(false);
    expect(readNeedsVisaSponsorship(fail)).toBe(false);
  });
});
