// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CompanyResearchDetails } from "@/components/companies/company-research-details";
import type { CompanyResearchItem } from "@/lib/research/company-overview";
import en from "../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/jobs/[id]/research-actions", () => ({ requestCompanyResearchAction: vi.fn(), companyResearchStatusAction: vi.fn(), confirmCompanyDomainAction: vi.fn(), saveCompanyDomainAction: vi.fn() }));

const latest: NonNullable<CompanyResearchItem["latest"]> = {
  fields: { summary: { text: "Builds robots.", sourceUrl: "https://example.org/about" }, size: { text: "201-500", sourceUrl: "javascript:alert(1)" } },
  id: 1,
  companyId: 1,
  fetchedAt: new Date("2026-11-01T10:00:00.000Z"),
  expiresAt: null,
  expired: false,
  domainUsed: null,
  provider: "openai",
  model: "m",
  dropped: 0,
};

function show(node: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

const props = { company: "Acme", companyId: 1, canRefresh: true, canEditDomain: false, providers: ["openai"] as const, timeZone: "UTC" };

describe("CompanyResearchDetails", () => {
  it("shows one line closed, and the fields with safe sources once opened", () => {
    show(<CompanyResearchDetails {...props} info={{ latest, website: null, jobId: 7 }} />);
    expect(screen.getByTestId("company-research-summary").textContent).toBe("Builds robots.");
    expect(screen.getByTestId("company-research-size").textContent).toBe("201-500");
    const toggle = screen.getByTestId("company-research-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("company-research-field-summary")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("company-research-field-summary")).toBeTruthy();
    // only an https source becomes a link
    expect(screen.getAllByTestId("company-research-source").map((a) => a.getAttribute("href"))).toEqual(["https://example.org/about"]);
    expect(screen.getByTestId("company-overview-refresh")).toBeTruthy();
  });

  it("has no refresh button when a lookup cannot be asked for", () => {
    show(<CompanyResearchDetails {...props} canRefresh={false} info={{ latest, website: null, jobId: 7 }} />);
    fireEvent.click(screen.getByTestId("company-research-toggle"));
    expect(screen.queryByTestId("company-overview-refresh")).toBeNull();
  });

  it("renders nothing with no result and no website editing", () => {
    show(<CompanyResearchDetails {...props} info={{ latest: null, website: null, jobId: 7 }} />);
    expect(screen.queryByTestId("company-research-details")).toBeNull();
  });
});
