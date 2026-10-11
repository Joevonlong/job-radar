import type { GmailPlatform, GmailSettings } from "@/lib/config";

import type { AlertParser } from "../types";
import { indeedParser } from "./indeed";
import { linkedinParser } from "./linkedin";
import { stepstoneParser } from "./stepstone";
import { xingParser } from "./xing";

export { indeedParser, linkedinParser, stepstoneParser, xingParser };

export const PARSERS: Readonly<Record<GmailPlatform, AlertParser>> = {
  linkedin: linkedinParser,
  stepstone: stepstoneParser,
  indeed: indeedParser,
  xing: xingParser,
};

/** The platform whose configured sender domain matches `address` (exact domain or subdomain), else null. */
export function platformOfSender(address: string, senders: GmailSettings["senders"]): GmailPlatform | null {
  const domain = address.toLowerCase().split("@").pop()?.trim() ?? "";
  if (!domain) return null;
  for (const platform of Object.keys(PARSERS) as GmailPlatform[]) {
    if (senders[platform].some((d) => domain === d || domain.endsWith(`.${d}`))) return platform;
  }
  return null;
}
