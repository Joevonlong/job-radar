import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SalaryLookupCard, type SalaryLookupCardProps } from "@/components/jobs/detail/salary-lookup-card";
import en from "../../messages/en.json";

const { lookupSalaryAction, salaryLookupStatusAction } = vi.hoisted(() => ({ lookupSalaryAction: vi.fn(), salaryLookupStatusAction: vi.fn() }));
vi.mock("@/app/jobs/[id]/salary-actions", () => ({ lookupSalaryAction, salaryLookupStatusAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
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
