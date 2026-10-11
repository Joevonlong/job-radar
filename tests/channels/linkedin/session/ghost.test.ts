// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sessionRepostLabel } from "@/lib/channels/linkedin/session/payload";

import { setup } from "./helpers";

const payload = (postedText: string | null) => ({ jobId: "4385000101", url: "https://www.linkedin.com/jobs/view/4385000101/", source: "search", title: "AI Engineer", companyName: "Acme", postedText });

describe("ghost job check declarations of the session channels", () => {
  it("both declare stable ids, the full text, a trusted posted date and a repost label", () => {
    const { session, recommended } = setup();
    for (const channel of [session, recommended]) {
      expect(channel.stableExternalIds).toBe(true);
      expect(channel.fullDescription).toBe(true);
      expect(channel.trustedPostedAt).toBe(true);
      expect(typeof channel.repostLabel).toBe("function");
    }
  });

  it("the label is the page's posted text, as it was; nothing for a missing or invalid one", () => {
    expect(sessionRepostLabel(payload(" Reposted 2 weeks ago "))).toBe("Reposted 2 weeks ago");
    expect(sessionRepostLabel(payload("Wiedereingestellt vor 3 Tagen"))).toBe("Wiedereingestellt vor 3 Tagen");
    expect(sessionRepostLabel(payload(null))).toBeNull();
    expect(sessionRepostLabel(payload("  "))).toBeNull();
    expect(sessionRepostLabel({ jobId: 1 })).toBeNull();
  });
});
