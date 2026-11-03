// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { requestResearchItemAction } from "@/app/jobs/[id]/research-bar-actions";
import { ResearchBar } from "@/components/jobs/detail/research-bar";
import type { ResearchBarStatus } from "@/lib/research/bar-view";
import { toastTone } from "@/lib/toast";
import en from "../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/jobs/[id]/research-bar-actions", () => ({ requestResearchAction: vi.fn(), requestResearchItemAction: vi.fn(), researchStatusAction: vi.fn(async () => null) }));

vi.mock("@/lib/toast", () => ({ toastTone: vi.fn() }));

const show = (initial: ResearchBarStatus) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ResearchBar jobId={1} initial={initial} timeZone="UTC" />
    </NextIntlClientProvider>,
  );

describe("ResearchBar", () => {
  it("keeps the buttons for an automatic request still waiting", () => {
    show({ canRequest: true, items: { company: { state: "running", stage: "pending", auto: true } } });
    expect(screen.getByTestId("research-bar-company-run")).toBeTruthy();
    expect(screen.getByTestId("research-bar-all")).toBeTruthy();
  });

  it("says so when the daily limit stops a press from moving the request up, and it still reads as queued", async () => {
    const status: ResearchBarStatus = { canRequest: true, items: { company: { state: "running", stage: "pending", auto: true } } };
    vi.mocked(requestResearchItemAction).mockResolvedValue({ ok: true, status, errors: { company: "quota" } });
    show(status);
    fireEvent.click(screen.getByTestId("research-bar-company-run"));
    await waitFor(() => expect(toastTone).toHaveBeenCalledWith("error", `${en.research.bar.item.company}: ${en.research.bar.error.quota}`));
    expect(screen.getByTestId("research-bar-company").textContent).toContain(en.research.bar.state.queuedAuto);
  });

  it("has no button once the worker has it, or for a request the user made", () => {
    show({ canRequest: true, items: { company: { state: "running", stage: "running", auto: true }, salary: { state: "running", stage: "pending", auto: false } } });
    expect(screen.queryByTestId("research-bar-company-run")).toBeNull();
    expect(screen.queryByTestId("research-bar-salary-run")).toBeNull();
    expect(screen.queryByTestId("research-bar-all")).toBeNull();
  });

  it("links a part that is off to its settings, with no button", () => {
    show({ canRequest: true, items: { salary: { state: "off", settingsTab: "salary" } } });
    expect(screen.getByTestId("research-bar-salary-settings").getAttribute("href")).toBe("/settings?tab=salary");
    expect(screen.queryByTestId("research-bar-salary-run")).toBeNull();
  });
});
