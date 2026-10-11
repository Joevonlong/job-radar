/**
 * How a channel reaches its data when that is a terms-of-service matter: `scraping` reads the public pages of a site whose
 * terms restrict automated access, `account_automation` drives the user's own logged-in account. Channels that use an official
 * API, a company's public job-board API or the user's own e-mail are not listed. A code classification, not a tunable value.
 * Switching a listed channel on needs the user's acknowledgement (setup wizard, source registry switch).
 */
import type { ConfiguredChannelId } from "./registry";

export type ConsentKind = "scraping" | "account_automation";

export const CHANNEL_ACCESS: Partial<Record<ConfiguredChannelId, ConsentKind>> = {
  "linkedin-guest": "scraping",
  indeed: "scraping",
  stepstone: "scraping",
  xing: "scraping",
  "jobspy-google": "scraping",
  "linkedin-session": "account_automation",
  "linkedin-session:recommended": "account_automation",
};

/** The kind of consent a channel (or board entry) id needs, or null. */
export function consentKind(id: string): ConsentKind | null {
  return (CHANNEL_ACCESS as Record<string, ConsentKind | undefined>)[id] ?? null;
}
