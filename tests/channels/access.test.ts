// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHANNEL_ACCESS, consentKind } from "@/lib/channels/access";
import { isConfiguredChannelId } from "@/lib/channels/registry";

describe("channel access classification", () => {
  it("lists only configured channels", () => {
    for (const id of Object.keys(CHANNEL_ACCESS)) expect(isConfiguredChannelId(id), id).toBe(true);
  });

  it("classifies the scraping channels and the account-driven ones", () => {
    for (const id of ["linkedin-guest", "indeed", "stepstone", "xing", "jobspy-google"]) expect(consentKind(id), id).toBe("scraping");
    for (const id of ["linkedin-session", "linkedin-session:recommended"]) expect(consentKind(id), id).toBe("account_automation");
  });

  it("needs no consent for official APIs, company boards and e-mail", () => {
    for (const id of ["arbeitsagentur", "jsearch", "greenhouse", "lever", "gmail-alerts", "tavily", "linkedin-brightdata", "linkedin-apify", "board:greenhouse:acme"]) {
      expect(consentKind(id), id).toBeNull();
    }
  });
});
