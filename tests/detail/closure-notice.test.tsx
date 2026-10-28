import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { ClosureNotice } from "@/components/jobs/detail/closure-notice";
import type { JobClosure } from "@/lib/db/queries/job-detail";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/jobs/closure-actions", () => ({ closeJobAction: vi.fn(), reopenJobAction: vi.fn(), undoClosureAction: vi.fn() }));

describe.each(["en", "zh"] as const)("closure evidence in %s", (locale) => {
  const quote = locale === "en" ? "This role is no longer accepting applications." : "此岗位已停止接受申请。";
  const linkCheck = {
    outcome: "phrase" as const, httpStatus: 200, phrase: "no longer accepting", quote,
    url: "https://jobs.example/1", at: "2026-10-10T08:00:00.000Z",
  };
  const show = (reason: JobClosure["reason"], evidence: JobClosure["linkCheck"] = linkCheck) => render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="UTC">
      <ClosureNotice jobId={1} title="Engineer" closure={{ autoStatus: "possibly_closed", reason, override: null, linkCheck: evidence }} lastSeenAt={new Date("2026-08-01T12:00:00Z")} timezone="UTC" />
    </NextIntlClientProvider>,
  );

  it.each(["dormant", "phrase", "manual", "gone", "possibly", null] as const)("keeps the closing phrase in the evidence row with reason %s", (reason) => {
    show(reason);
    expect(screen.getByTestId("closure-checked")).toHaveTextContent(quote);
    expect(screen.getAllByText(quote)).toHaveLength(1);
    expect(screen.getByRole("link", { name: locale === "en" ? en.dashboard.closed.evidenceLink : zh.dashboard.closed.evidenceLink })).toHaveAttribute("href", linkCheck.url);
    if (reason === "dormant") {
      expect(screen.getByTestId("closure-hint")).toHaveTextContent(locale === "en" ? "No source has listed" : "已经数周");
      expect(screen.getByTestId("closure-last-listed")).toHaveTextContent(locale === "en" ? "Last listed by a source on" : "最后一次被来源列出");
      expect(screen.getByRole("button", { name: locale === "en" ? "Still open" : "仍在招" })).toBeInTheDocument();
    }
  });

  it("does not show a stale quote when the latest check found the page alive", () => {
    show("dormant", { ...linkCheck, outcome: "alive" });
    expect(screen.getByTestId("closure-checked")).not.toHaveTextContent(quote);
  });
});
