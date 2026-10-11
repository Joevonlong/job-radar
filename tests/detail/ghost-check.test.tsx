import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChecksPanel } from "@/components/jobs/detail/checks-panel";
import { GhostMark } from "@/components/jobs/ghost-mark";
import { floorCheck } from "@/lib/dashboard/floor-check";
import { germanCheck } from "@/lib/dashboard/german-check";
import type { GhostOfJob, GhostReason } from "@/lib/ghost/types";
import { buildGhostCheckView } from "@/lib/ghost/view";
import { buildVisaCheckView } from "@/lib/visa/view";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const action = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, changed: true })));
vi.mock("@/app/jobs/[id]/ghost-actions", () => ({ setGhostDismissAction: action }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const reasons: GhostReason[] = [
  { code: "long_open", points: 2, days: 214, since: "2026-02-28", from: "posted", channelId: "greenhouse" },
  { code: "evergreen_wording", points: 2, patternId: "talent_pool", quote: "This posting is for our talent pool.", offset: 0 },
  { code: "thin_description", points: 1, words: 40, minWords: 120, hasResponsibilities: false, responsibilitiesFrom: "headings", channelId: "greenhouse" },
];
const stored = (over: Partial<GhostOfJob> = {}): GhostOfJob => ({ level: "likely", score: 5, reasons, checkedAt: new Date(), dismissedAt: null, dismissedCodes: null, dismissed: false, ...over });
const base = { german: germanCheck("none", null), germanPenalty: null, skills: [], profileHasSkills: true, floor: floorCheck(null, 70000, "EUR") };

describe("GhostMark", () => {
  it("likely: warn with the hatch; the tooltip names the reasons and says the score is not affected", () => {
    render(wrap(<GhostMark ghost={{ level: "likely", score: 5, reasons: "open 214 days · thin JD" }} />));
    const mark = screen.getByTestId("ghost-mark");
    expect(mark).toHaveTextContent(en.ghostJobs.mark.likely);
    expect(mark).toHaveAttribute("data-level", "likely");
    expect(mark.className).toContain("ghost-likely");
    expect(mark.className).toContain("bg-warn");
    expect(mark.getAttribute("title")).toContain("open 214 days · thin JD");
    expect(mark.getAttribute("title")).toContain("score is not affected");
  });

  it("watch: grey; with href a link to the checks card", () => {
    render(wrap(<GhostMark ghost={{ level: "watch", score: 3, reasons: "open 120 days" }} href="#h-checks" />, "zh"));
    const mark = screen.getByTestId("ghost-mark");
    expect(mark.tagName).toBe("A");
    expect(mark).toHaveAttribute("href", "#h-checks");
    expect(mark).toHaveTextContent(zh.ghostJobs.mark.watch);
    expect(mark.className).not.toContain("bg-warn");
  });
});

describe("ChecksPanel ghost row", () => {
  it("lists every reason, shows the quote with a jump and the dismiss button", async () => {
    render(wrap(<ChecksPanel {...base} ghost={{ jobId: 9, view: buildGhostCheckView(stored()), jdIndex: 0 }} />));
    const row = screen.getByTestId("ghost-check");
    expect(row).toHaveTextContent("Likely ghost (5 points)");
    expect(within(row).getAllByTestId("ghost-check-reason")).toHaveLength(3);
    expect(row).toHaveTextContent("Open 214 days (source posted date 2026-02-28, greenhouse)");
    expect(row).toHaveTextContent("This posting is for our talent pool.");
    expect(within(row).getByTestId("ghost-check-note")).toHaveTextContent("does not mean the job is not real");
    await userEvent.click(within(row).getByTestId("ghost-dismiss"));
    expect(action).toHaveBeenCalledWith({ jobId: 9, action: "dismiss" });
  });

  it("names the channels by the page's display names", () => {
    render(wrap(<ChecksPanel {...base} ghost={{ jobId: 9, view: buildGhostCheckView(stored()), jdIndex: 0, channelNames: { greenhouse: "Greenhouse" } }} />));
    expect(screen.getByTestId("ghost-check")).toHaveTextContent("Open 214 days (source posted date 2026-02-28, Greenhouse)");
  });

  it("comes after the traps and before visa", () => {
    render(
      wrap(
        <ChecksPanel
          {...base}
          ghost={{ jobId: 9, view: buildGhostCheckView(stored()), jdIndex: null }}
          visa={{ view: buildVisaCheckView(null, false), jdIndex: null }}
        />,
      ),
    );
    const ids = Array.from(document.querySelectorAll("[data-testid$='-check']"), (el) => el.getAttribute("data-testid"));
    expect(ids.indexOf("ghost-check")).toBeLessThan(ids.indexOf("visa-check"));
  });

  it("dismissed: the undo button and the note; clear: no reasons, no button", () => {
    const { unmount } = render(wrap(<ChecksPanel {...base} ghost={{ jobId: 9, view: buildGhostCheckView(stored({ dismissed: true, dismissedCodes: ["long_open", "evergreen_wording", "thin_description"] })), jdIndex: null }} />));
    expect(screen.getByTestId("ghost-check")).toHaveTextContent(en.ghostJobs.checks.dismissed);
    expect(screen.getByTestId("ghost-undo")).toBeInTheDocument();
    expect(screen.getByTestId("ghost-check-note")).toHaveTextContent(en.ghostJobs.checks.dismissedNote);
    unmount();
    render(wrap(<ChecksPanel {...base} ghost={{ jobId: 9, view: buildGhostCheckView(stored({ level: "none", score: 1, reasons: [reasons[2] as GhostReason] })), jdIndex: 0 }} />));
    expect(screen.getByTestId("ghost-check")).toHaveTextContent(en.ghostJobs.checks.clear);
    expect(screen.queryByTestId("ghost-check-reason")).toBeNull();
    expect(screen.queryByTestId("ghost-dismiss")).toBeNull();
  });

  it("absent while the check is off", () => {
    render(wrap(<ChecksPanel {...base} ghost={null} />));
    expect(screen.queryByTestId("ghost-check")).toBeNull();
  });
});
