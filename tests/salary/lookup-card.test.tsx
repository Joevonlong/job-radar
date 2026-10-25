import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SalaryLookupCard, type SalaryLookupCardProps } from "@/components/jobs/detail/salary-lookup-card";
import { salaryLookupResultSchema } from "@/lib/salary/lookup-types";
import type { SalaryLookupView } from "@/lib/salary/view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const { lookupSalaryAction, salaryLookupStatusAction } = vi.hoisted(() => ({ lookupSalaryAction: vi.fn(), salaryLookupStatusAction: vi.fn() }));
vi.mock("@/app/jobs/[id]/salary-actions", () => ({ lookupSalaryAction, salaryLookupStatusAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

const props = (over: Partial<SalaryLookupCardProps> = {}): SalaryLookupCardProps => ({
  jobId: 7,
  company: "Acme",
  availability: "enabled",
  unrestricted: false,
  providers: ["claude-cli", "anthropic"],
  latest: null,
  initialRequest: null,
  usedToday: 0,
  maxPerDay: 3,
  ttlDays: 30,
  currency: "EUR",
  groupQuantiles: null,
  timeZone: "Europe/Berlin",
  ...over,
});

function lookup(over: Partial<SalaryLookupView> = {}): SalaryLookupView {
  const band = {
    title: "Software Engineer", seniority: "senior", location: "Example City", basis: "base",
    min: 80000, max: 100000, median: 90000, convertible: true,
    original: { min: 80000, max: 100000, median: 90000, currency: "EUR" }, sources: [0],
  };
  return {
    id: 1, origin: { jobId: 7, title: band.title }, provider: "seed", model: "seed",
    fetchedAt: "2026-01-01T12:00:00.000Z", expired: false,
    result: salaryLookupResultSchema.parse({
      query: { company: "Acme", title: band.title, seniority: "senior", city: "Example City", country: "DE", currency: "EUR" },
      companyLevel: { level: "market", median: 90000, summary: "Fictional salary estimate", sources: [0] },
      roleBand: band,
      relatedRoles: [{ ...band, title: "Platform Engineer" }, { ...band, title: "Backend Engineer" }],
      sources: [
        { url: "https://salary.example.org/roles", host: "salary.example.org", site: "Salary site", title: "Salary estimates", excerpt: "Example salaries", trusted: true },
        { url: "https://blog.example.org/pay", host: "blog.example.org", site: "Blog", title: "Pay estimates", excerpt: "Example pay", trusted: false },
      ],
      confidence: "medium", notes: "Fictional lookup", dropped: 0, observations: [],
    }),
    ...over,
  };
}

beforeEach(() => {
  lookupSalaryAction.mockReset();
  salaryLookupStatusAction.mockReset();
});

describe("SalaryLookupCard", () => {
  it("counts a queued lookup at once, without a reload", async () => {
    lookupSalaryAction.mockResolvedValue({ ok: true, queued: true, requestId: 11, usedToday: 1 });
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "pending" });
    render(wrap(<SalaryLookupCard {...props()} />));
    expect(screen.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used", "0");
    await userEvent.click(screen.getByTestId("salary-lookup-button"));
    await waitFor(() => expect(screen.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used", "1"));
  });

  it("with the daily limit used up the button is disabled, says why and offers no retry", () => {
    render(wrap(<SalaryLookupCard {...props({ usedToday: 3, initialRequest: { state: "failed", error: "auth", detail: null } })} />));
    const button = screen.getByTestId("salary-lookup-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-blocked", "quota");
    expect(button).not.toHaveTextContent("Try again");
    expect(screen.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used-up", "true");
    expect(screen.getByTestId("salary-lookup-quota")).toHaveTextContent("All 3 lookups of the last 24 hours are used");
  });

  it("a login failure names the logins of the providers the lookup can use, and only those", () => {
    render(wrap(<SalaryLookupCard {...props({ usedToday: 1, initialRequest: { state: "failed", error: "auth", detail: null } })} />));
    const error = screen.getByTestId("salary-lookup-error");
    expect(error).toHaveTextContent("claude-cli, anthropic");
    expect(error).toHaveTextContent("claude → /login");
    expect(error).toHaveTextContent("ANTHROPIC_API_KEY");
    expect(error).not.toHaveTextContent("codex");
    expect(screen.getByTestId("salary-lookup-button")).toHaveTextContent("Try again");
  });
});

describe.each(["en", "zh"] as const)("salary lookup trust labels (%s)", (locale) => {
  const text = locale === "en" ? en.salary.lookup : zh.salary.lookup;

  it("labels the AI's confidence, every estimate and its sources, and explains the shared scope", () => {
    render(wrap(<SalaryLookupCard {...props({ latest: lookup() })} />, locale));
    const card = screen.getByTestId("salary-lookup-card");
    expect(screen.getByTestId("salary-lookup-ai-badge")).toHaveTextContent(locale === "en" ? "AI lookup" : "AI 查询");
    const mark = locale === "en" ? "AI estimate (unverified)" : "AI 估计（未核对）";
    for (const id of ["salary-lookup-role", "salary-lookup-related-0", "salary-lookup-related-1", "salary-lookup-company"]) {
      expect(screen.getByTestId(`${id}-unverified`)).toHaveTextContent(mark);
    }
    expect(screen.getByTestId("salary-lookup-confidence")).toHaveTextContent(locale === "en" ? "AI's own confidence" : "AI 自评置信度");
    expect(screen.getByRole("heading", { name: locale === "en" ? "Sources given by the AI (unverified)" : "AI 给出的来源（未核对）" })).toBeVisible();
    expect(screen.getByTestId("salary-lookup-other-source")).toHaveTextContent(locale === "en" ? "not on your salary-site list" : "不在薪资网站列表中");
    expect(screen.getByTestId("salary-lookup-disclaimer")).toHaveTextContent(text.disclaimer);
    expect(screen.getByTestId("salary-lookup-scope")).toHaveTextContent(locale === "en" ? "It is not based on this job description." : "不是根据这条 JD。");
    expect(card).not.toHaveTextContent(/已核对|已验证|\bverified\b/i);
  });

  it("does not show an origin note for a lookup made on this posting", () => {
    render(wrap(<SalaryLookupCard {...props({ latest: lookup() })} />, locale));
    expect(screen.queryByTestId("salary-lookup-origin")).not.toBeInTheDocument();
    expect(screen.getByTestId("salary-lookup-scope")).toBeVisible();
  });

  it("links to the title of the other posting that started the lookup", () => {
    const origin = { jobId: 9, title: "Senior Software Engineer" };
    render(wrap(<SalaryLookupCard {...props({ latest: lookup({ origin }) })} />, locale));
    const note = screen.getByTestId("salary-lookup-origin");
    expect(note).toHaveTextContent(text.origin.replace("<link>{title}</link>", origin.title));
    expect(within(note).getByRole("link", { name: origin.title })).toHaveAttribute("href", "/jobs/9");
  });

  it("explains when the posting that started the lookup has been deleted", () => {
    render(wrap(<SalaryLookupCard {...props({ latest: lookup({ origin: null }) })} />, locale));
    const note = screen.getByTestId("salary-lookup-origin");
    expect(note).toHaveTextContent(locale === "en" ? "The posting this lookup was made on has been deleted." : "发起这次查询的岗位已删除。");
    expect(within(note).queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders old lookup rows with non-empty observations as unverified estimates", () => {
    const latest = lookup();
    latest.result = salaryLookupResultSchema.parse({
      ...latest.result,
      observations: [{ family: "software", seniority: "senior", city: "Example City", country: "DE", figure: 90000 }],
    });
    expect(latest.result.observations).toHaveLength(1);
    render(wrap(<SalaryLookupCard {...props({ latest })} />, locale));
    expect(screen.getByTestId("salary-lookup-role")).toHaveTextContent("Software Engineer");
    expect(screen.getByTestId("salary-lookup-role-unverified")).toBeVisible();
    expect(screen.getByTestId("salary-lookup-card")).not.toHaveTextContent(/已核对|已验证|\bverified\b/i);
  });
});
