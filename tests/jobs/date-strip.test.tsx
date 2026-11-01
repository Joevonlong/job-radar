import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { DateStrip } from "@/components/jobs/detail/date-strip";
import { buildPostedView, type PostedView } from "@/lib/jobs/posted-view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const NOW = new Date("2026-10-31T12:00:00Z");
const FIRST_SEEN = new Date("2026-10-27T08:12:00Z");
const NAMES = { greenhouse: "Greenhouse", indeed: "Indeed" };

const view = (over: Partial<Parameters<typeof buildPostedView>[0]> = {}): PostedView =>
  buildPostedView({ postedAt: new Date("2026-10-02T09:00:00Z"), sources: [{ channelId: "greenhouse" }], ghost: null, ghostOn: true, trustedChannels: new Set(["greenhouse"]), ...over });

function show(postedView: PostedView, locale: "en" | "zh" = "en", extra: { relistedText?: string | null } = {}) {
  const wrap = (node: ReactNode) => (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {node}
    </NextIntlClientProvider>
  );
  return render(
    wrap(<DateStrip view={postedView} firstSeenAt={FIRST_SEEN} now={NOW} timezone="Europe/Berlin" sourceNames={["Greenhouse"]} channelNames={NAMES} relistedText={extra.relistedText ?? null} />),
  );
}

describe("DateStrip", () => {
  it("writes the day first and the relative time in brackets, with a datetime", () => {
    show(view());
    const chip = screen.getByTestId("posted-date");
    expect(chip).toHaveTextContent("Posted Oct 2 Fri (29 days ago)");
    expect(chip.querySelector("time")).toHaveAttribute("datetime", "2026-10-02T09:00:00.000Z");
  });

  it("explains the date in the tooltip and again as screen-reader text inside the chip", () => {
    show(view());
    const chip = screen.getByTestId("posted-date");
    const tip = chip.getAttribute("title") ?? "";
    expect(tip).toContain("2026-10-02 11:00 (Europe/Berlin)");
    expect(tip).toContain("Greenhouse states the posting date itself");
    expect(chip.querySelector(".sr-only")).toHaveTextContent(tip);
  });

  it("a date without a time shows no hours and says the source gave only a date", () => {
    show(view({ postedAt: new Date("2026-10-27T00:00:00Z"), sources: [{ channelId: "indeed" }] }));
    const chip = screen.getByTestId("posted-date");
    expect(chip).toHaveTextContent("Posted Oct 27 Tue (4 days ago)");
    expect(chip.getAttribute("title")).toContain("2026-10-27 (the source gave only a date)");
    expect(chip.getAttribute("title")).toContain("for reference only");
    expect(chip.getAttribute("title")).not.toContain("Europe/Berlin");
  });

  it("an unknown date says so; first seen still shows", () => {
    show(view({ postedAt: null }));
    expect(screen.getByTestId("posted-date")).toHaveTextContent("Posted date unknown");
    expect(screen.getByTestId("posted-date").getAttribute("title")).toContain("sorting by posted date puts this job last");
    expect(screen.getByTestId("first-seen")).toHaveTextContent("First seen Oct 27 09:12 · Greenhouse");
  });

  it("no repost chip without evidence", () => {
    show(view());
    expect(screen.queryByTestId("repost-date")).not.toBeInTheDocument();
  });

  it("a repost keeps the posted chip and gets a chip of its own that says we first saw the link", () => {
    show(view({ ghost: { reasons: [{ code: "reposted", points: 2, channelId: "greenhouse", events: [{ oldId: "a", newId: "b", oldSeen: "2026-10-02", newSeen: "2026-10-27", gapDays: 25 }] }] } }));
    expect(screen.getByTestId("posted-date")).toHaveTextContent("Posted Oct 2 Fri (29 days ago)");
    const repost = screen.getByTestId("repost-date");
    expect(repost).toHaveTextContent("Reposted · new link Oct 27 (first seen by us, 4 days ago)");
    expect(repost.getAttribute("title")).toContain("not a date the source gave");
    expect(repost.getAttribute("title")).toContain("first seen Oct 2, 25 days earlier");
  });

  it("only the source's label: no date, the label in the tooltip", () => {
    show(view({ ghost: { reasons: [{ code: "repost_label", points: 1, channelId: "linkedin", label: "Reposted 2 weeks ago" }] } }));
    const repost = screen.getByTestId("repost-date");
    expect(repost).toHaveTextContent("Reposted (source label)");
    expect(repost.getAttribute("title")).toContain("Reposted 2 weeks ago");
  });

  it("ten relistings say how many are recorded, without claiming some were dropped", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ oldId: `o${i}`, newId: `n${i}`, oldSeen: "2026-01-02", newSeen: `2026-10-${String(10 + i).padStart(2, "0")}`, gapDays: 30 }));
    show(view({ ghost: { reasons: [{ code: "reposted", points: 2, channelId: "greenhouse", events }] } }));
    expect(screen.getByTestId("repost-date").getAttribute("title")).toContain("10 link changes recorded, the oldest old link among them was first seen Jan 2");
  });

  it("keeps the seen-again text where it was, inside first-seen", () => {
    show(view(), "en", { relistedText: "Oct 29, 2026, 10:00 AM seen again" });
    expect(screen.getByTestId("first-seen")).toContainElement(screen.getByTestId("relisted-detail"));
    expect(screen.getByTestId("relisted-detail")).toHaveTextContent("seen again");
  });

  it("reads in Chinese", () => {
    show(view({ postedAt: new Date("2026-10-27T00:00:00Z") }), "zh");
    expect(screen.getByTestId("posted-date")).toHaveTextContent("发布 10/27 周二（4 天前）");
    expect(screen.getByTestId("first-seen")).toHaveTextContent("首次发现 10/27 09:12 · Greenhouse");
  });
});
