import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFormatter, createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { JobTags } from "@/components/jobs/job-tags";
import { RelistedNote } from "@/components/jobs/relisted-note";
import { toListItems } from "@/components/jobs/to-list-items";
import type { JobCard } from "@/lib/db/queries/types";
import { JobBadges } from "@/components/jobs/job-badges";
import type { JobListItem } from "@/components/jobs/types";
import { SignalBadge } from "@/components/jobs/signal-badge";
import { SourceIcon } from "@/components/jobs/source-icons";
import { VisaBadge } from "@/components/jobs/visa-badge";
import en from "../messages/en.json";
import { listSignal } from "./signals/helpers";
import { BaseCurrencyProvider } from "@/components/base-currency";
import { ScopeSwitch } from "@/components/jobs/scope-switch";
import { loadJobsSearchParams } from "@/lib/jobs/search-params";

describe("scope switch", () => {
  const show = (query: string) => render(wrap(<ScopeSwitch params={loadJobsSearchParams(query)} archiveCount={7} />));
  const queryOf = (scope: string) => new URL(screen.getByTestId(`scope-${scope}`).getAttribute("href")!, "https://example.test").searchParams;

  it("writes explicit scope and removes page on every link, leaving archive sort implicit", () => {
    show("?q=engineer&status=closed&page=3");
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("scope-archive")).toHaveTextContent("Archive (7)");
    for (const scope of ["current", "archive", "all"]) {
      expect(queryOf(scope).get("scope")).toBe(scope);
      expect(queryOf(scope).has("page")).toBe(false);
      expect(queryOf(scope).has("sort")).toBe(false);
      expect(queryOf(scope).get("q")).toBe("engineer");
      expect(queryOf(scope).get("status")).toBe("closed");
    }
  });

  it("clears reasons outside archive, and last-listed sort and direction only on Current", () => {
    show("?scope=archive&reason=gone&sort=last_listed&dir=asc&page=2");
    expect(screen.getByTestId("scope-archive")).toHaveAttribute("aria-current", "true");
    expect(queryOf("archive").get("reason")).toBe("gone");
    expect(queryOf("archive").get("sort")).toBe("last_listed");
    for (const scope of ["current", "all"]) expect(queryOf(scope).has("reason")).toBe(false);
    expect(queryOf("current").has("sort")).toBe(false);
    expect(queryOf("current").has("dir")).toBe(false);
    expect(queryOf("all").get("sort")).toBe("last_listed");
    expect(queryOf("all").get("dir")).toBe("asc");
  });

  it("preserves another explicit sort and direction on every destination", () => {
    show("?sort=salary&dir=asc");
    for (const scope of ["current", "archive", "all"]) {
      expect(queryOf(scope).get("sort")).toBe("salary");
      expect(queryOf(scope).get("dir")).toBe("asc");
    }
  });

  it("pins Current despite a closed status and puts every scope link in native Tab order", async () => {
    show("?scope=current&status=closed");
    const group = screen.getByRole("group", { name: "Job scope" });
    expect(group.tagName).toBe("DIV");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    const links = within(group).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(within(group).getByRole("link", { current: true })).toHaveTextContent("Current");
    const user = userEvent.setup();
    for (const link of links) {
      await user.tab();
      expect(link).toHaveFocus();
    }
    await user.tab({ shift: true });
    expect(within(group).getByRole("link", { name: "Archive (7)" })).toHaveFocus();
    expect(links.filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
  });
});

const wrap = (node: ReactNode) => (
  <BaseCurrencyProvider currency="EUR" language="de">
    <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
  </BaseCurrencyProvider>
);

describe("SignalBadge", () => {
  it.each(["T1", "T2", "T3", "T4", "tag", "visa"])("renders category %s", (tier) => {
    render(
      <SignalBadge tier={tier} color="violet">
        label
      </SignalBadge>,
    );
    expect(screen.getByText("label").closest("[data-slot=signal-badge]")).toHaveAttribute("data-tier", tier);
  });

  it("uses the light-theme-safe text token of the category colour", () => {
    render(
      <SignalBadge tier="T3" color="coral">
        x
      </SignalBadge>,
    );
    expect(screen.getByText("x").closest("[data-slot=signal-badge]")?.className).toContain("text-signal-t3-text");
  });
});

describe("VisaBadge", () => {
  it("says support in green and a refusal in a dashed red outline, by kind", () => {
    const { rerender } = render(wrap(<VisaBadge visa={{ status: "offered", kind: null }} />));
    expect(screen.getByTestId("visa-badge")).toHaveTextContent(en.visa.badge.offered);
    expect(screen.getByTestId("visa-badge").className).toContain("text-good");
    rerender(wrap(<VisaBadge visa={{ status: "not_offered", kind: "permit_required" }} />));
    expect(screen.getByTestId("visa-badge")).toHaveTextContent(en.visa.badge.permit_required);
    expect(screen.getByTestId("visa-badge")).toHaveAttribute("data-kind", "permit_required");
    expect(screen.getByTestId("visa-badge").className).toContain("border-dashed");
    rerender(wrap(<VisaBadge visa={{ status: "not_offered", kind: "no_sponsorship" }} />));
    expect(screen.getByTestId("visa-badge")).toHaveTextContent(en.visa.badge.no_sponsorship);
    expect(screen.getByTestId("visa-badge")).toHaveAttribute("title", en.visa.badgeTitle.no_sponsorship);
  });
});

describe("SourceIcon", () => {
  it("names the family for assistive tech and falls back for unknown families", () => {
    render(wrap(<SourceIcon family="ats" />));
    expect(screen.getByText("Company ATS")).toBeInTheDocument();
    render(wrap(<SourceIcon family="newboard" />));
    expect(screen.getByText("newboard")).toBeInTheDocument();
  });
});

const item = (over: Partial<JobListItem> = {}): JobListItem => ({
  id: 1,
  title: "t",
  companyName: "c",
  locations: [],
  workplace: "unknown",
  contract: "unknown",
  isAgency: false,
  germanLevelRequired: "unknown",
  jobStatus: "active",
  salaryDisclosed: false,
  salaryText: null,
  families: [],
  applicationStatus: null,
  rank: null,
  signals: [],
  timeLabel: "",
  timeTitle: "",
  posted: { day: "10/27", ago: "4 d", title: "", known: true },
  ...over,
});

describe("JobBadges", () => {
  it("shows the dashed unknown badge when no salary is stated, never a salary (C3)", () => {
    render(wrap(<JobBadges job={item()} />));
    expect(screen.getByText(/Salary not disclosed/)).toBeInTheDocument();
  });

  it("shows agency, freelance and the German requirement from the pipeline flags", () => {
    render(wrap(<JobBadges job={item({ isAgency: true, contract: "freelance", germanLevelRequired: "B2" })} />));
    expect(screen.getByText("Agency")).toBeInTheDocument();
    expect(screen.getByText("Freelance")).toBeInTheDocument();
    expect(screen.getByText("German B2")).toBeInTheDocument();
  });

  it("does not flag German when the posting says it is not needed or says nothing", () => {
    const { rerender } = render(wrap(<JobBadges job={item({ germanLevelRequired: "none" })} />));
    expect(screen.queryByText(/German/)).toBeNull();
    rerender(wrap(<JobBadges job={item({ germanLevelRequired: "unknown" })} />));
    expect(screen.queryByText(/German/)).toBeNull();
  });

  it("does not flag German as required when it is only preferred", () => {
    render(wrap(<JobBadges job={item({ germanLevelRequired: "preferred" })} />));
    expect(screen.queryByText(/German/)).toBeNull();
  });

  it("shows the stated salary as one 💰 annual range when there is no amount signal", () => {
    const { container } = render(wrap(<JobBadges job={item({ salaryDisclosed: true, salaryText: "€85–105k" })} />));
    const badge = container.querySelector("[data-slot=fact-badge]");
    expect(badge).toHaveTextContent("💰€85–105k");
    expect(screen.queryByText(/Salary not disclosed/)).toBeNull();
  });

  it("writes the same normalized range on the pay-signal badge, not the amount found in the text", () => {
    const signal = listSignal("T1", "salary_range", { min: 60000, max: 80000, currency: "EUR" });
    const { container } = render(wrap(<JobBadges job={item({ salaryDisclosed: true, salaryText: "€85–105k", signals: [signal] })} />));
    const badges = container.querySelectorAll("[data-slot=signal-badge]");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("💰€85–105k");
    expect(container.querySelector("[data-slot=fact-badge]")).toBeNull();
  });

  it("shows no salary at all, and not 'not disclosed', when the posting states one that is under review", () => {
    const { container } = render(wrap(<JobBadges job={item({ salaryDisclosed: true, salaryText: null })} />));
    expect(container.textContent).not.toMatch(/💰|Salary/);
  });
});

describe("AI trap badge", () => {
  it("comes first, says ×N for several, and explains itself", () => {
    render(wrap(<JobBadges job={item({ trapCount: 3, isAgency: true })} />));
    const badges = screen.getByTestId("trap-badge").parentElement?.children;
    expect(badges?.[0]).toBe(screen.getByTestId("trap-badge"));
    expect(screen.getByTestId("trap-badge")).toHaveTextContent("AI trap ×3");
    expect(screen.getByTestId("trap-badge")).toHaveAttribute("title", "The JD holds 3 traps aimed at AI; open the job to see");
  });

  it("is absent without traps", () => {
    render(wrap(<JobBadges job={item({ trapCount: 0 })} />));
    expect(screen.queryByTestId("trap-badge")).toBeNull();
    render(wrap(<JobBadges job={item({ trapCount: 1 })} />));
    expect(screen.getByTestId("trap-badge")).toHaveTextContent(/^AI trap$/);
  });
});


vi.mock("next-intl/server", () => ({
  getFormatter: () => createFormatter({ locale: "en", timeZone: "UTC" }),
  getLocale: () => "en",
  getTranslations: (namespace: "dashboard" | "ghostJobs") => createTranslator({ locale: "en", messages: en, namespace }),
}));

const relistNow = new Date("2026-10-01T12:00:00Z");
const relistCard = (relistedAt: Date | null, status: JobCard["status"] = "active"): JobCard => ({
  id: 1, title: "Engineer", companyId: 1, companyName: "Example", locations: [], workplace: "unknown",
  contract: "unknown", isAgency: false, germanLevelRequired: "unknown", status,
  closedReason: status === "closed" ? "manual" : status === "possibly_closed" ? "phrase" : null,
  linkCheck: null, postedAt: null, firstSeenAt: new Date("2026-08-01T12:00:00Z"), lastSeenAt: relistNow,
  lastListedAt: relistedAt, relistedAt, relistCount: 2, salaryDisclosed: false, salary: null, skills: [],
  sources: [], applicationStatus: null, favorite: null, rank: null, summary: null, signals: [], seen: true,
});
const relistItem = async (at: Date | null, status?: JobCard["status"]) => {
  const [job] = await toListItems([relistCard(at, status)], { now: relistNow, timezone: "UTC", relistBadgeDays: 3, visa: false, ghost: false });
  if (!job) throw new Error("Expected a list item");
  return job;
};

describe("seen-again tag", () => {
  it.each(["active", "closed", "possibly_closed"] as const)("shows at the window boundary for %s, with first seen, count and source-only meaning", async (status) => {
    render(wrap(<JobTags job={await relistItem(new Date("2026-09-28T12:00:00Z"), status)} />));
    expect(screen.getByTestId("relisted-tag")).toHaveTextContent("Seen again · 3 days ago");
    const title = screen.getByTestId("relisted-tag").getAttribute("title");
    expect(title).toContain("First seen Aug 1, 2026");
    expect(title).toContain("Seen again #2");
    expect(title).toContain(en.dashboard.relisted.hint);
  });

  it("hides just outside the configured window and when migration fallback supplies no relist", async () => {
    const { rerender } = render(wrap(<JobTags job={await relistItem(new Date("2026-09-28T11:59:59Z"))} />));
    expect(screen.queryByTestId("relisted-tag")).not.toBeInTheDocument();
    rerender(wrap(<JobTags job={await relistItem(null)} />));
    expect(screen.queryByTestId("relisted-tag")).not.toBeInTheDocument();
  });

  it("preserves first-seen freshness, new-since-visit and the usual time label", async () => {
    const before = await relistItem(null);
    const after = await relistItem(relistNow);
    expect(after.firstSeenHours).toBe(before.firstSeenHours);
    expect(after.isNew).toBe(before.isNew);
    expect(after.timeLabel).toBe(before.timeLabel);
    expect(after.timeTitle).toBe(before.timeTitle);
  });
});

describe("seen-again Today note", () => {
  it.each([
    { filtered: false, hideLang: false, high: false },
    { filtered: true, hideLang: true, high: true },
    { filtered: true, hideLang: false, high: false },
  ])("links to Current with relisted and the current visibility switches: %o", (toggles) => {
    render(wrap(<RelistedNote count={2} {...toggles} />));
    expect(screen.getByTestId("relisted-note")).toHaveTextContent("2 jobs seen again");
    const query = new URL(screen.getByTestId("relisted-note-link").getAttribute("href")!, "https://example.test").searchParams;
    expect(query.get("scope")).toBe("current");
    expect(query.get("relisted")).toBe("true");
    for (const key of ["filtered", "hideLang", "high"] as const) expect(query.get(key)).toBe(String(toggles[key]));
  });

  it("renders nothing for zero relists", () => {
    render(wrap(<RelistedNote count={0} filtered={false} hideLang={false} high={false} />));
    expect(screen.queryByTestId("relisted-note")).not.toBeInTheDocument();
  });
});
