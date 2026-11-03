import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaterialsPanel } from "@/components/writer/materials-panel";
import type { FitItem } from "@/lib/writer/fit";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

import en from "../messages/en.json";

const actions = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn(), requestFit: vi.fn(), fitStatus: vi.fn() }));
vi.mock("@/app/jobs/[id]/apply/actions", () => ({ updateQuestionAction: actions.update, requestFitAction: actions.requestFit, fitStatusAction: actions.fitStatus }));
vi.mock("@/app/jobs/[id]/breakdown-actions", () => ({ breakdownJobAction: vi.fn(), breakdownStatusAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }), unstable_isUnrecognizedActionError: () => false }));
const toasts = vi.hoisted(() => ({ tone: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastTone: toasts.tone }));

const question = (over: Partial<WorkbenchQuestion> = {}): WorkbenchQuestion =>
  ({ id: 1, selection: { jdPoints: [], useJdText: false, storyIds: ["billing"], profile: false, emphasis: "", company: null }, stale: { jdPoints: 0, stories: 0 }, companyUpdated: false, ...over }) as WorkbenchQuestion;

const fields: NonNullable<WorkbenchView["company"]>["fields"] = [
  { field: "summary", text: "Acme builds billing software.", sourceUrl: "https://example.org/about" },
  { field: "funding", text: "Series B.", sourceUrl: null },
];

const item = (over: Partial<FitItem> = {}): FitItem => ({ companyPoint: "Billing on Kotlin", yourPoint: "you migrated billing", companyQuote: "billing on Kotlin", storyRef: "billing", storyQuote: "migration of the billing service", status: "quotes_found", flags: [], missing: [], ...over });

const view = (over: Partial<WorkbenchView> = {}): WorkbenchView =>
  ({
    job: { id: 5, title: "T", company: "Acme", companyNames: ["Acme"], hasDescription: false },
    breakdown: "none",
    breakdownEnabled: false,
    jdPoints: [],
    stories: [{ id: "billing", title: "Billing migration", skills: [], period: null }],
    storiesUnreadable: false,
    profile: { available: false, summary: "", skills: [] },
    limits: { emphasisMaxChars: 200 },
    company: { researchId: 7, expired: false, fields },
    fit: { items: [], outdated: false, createdAt: "", openRequestId: null },
    ...over,
  }) as WorkbenchView;

const show = (v: WorkbenchView, q: WorkbenchQuestion = question()) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MaterialsPanel view={v} question={q} enabled timeZone="UTC" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.update.mockReset().mockResolvedValue({ ok: true });
  actions.requestFit.mockReset();
  toasts.tone.mockReset();
});

describe("the company background group", () => {
  it("is absent without a result", () => {
    show(view({ company: null }));
    expect(screen.queryByTestId("writer-company")).toBeNull();
    expect(screen.queryByTestId("writer-fit")).toBeNull();
  });

  it("says it is unverified, ticks nothing, and links only an https source", () => {
    show(view());
    const group = screen.getByTestId("writer-company");
    expect(group).toHaveTextContent("unverified");
    expect(within(group).getAllByRole("checkbox").every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);
    const links = within(group).getAllByTestId("writer-company-source");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.org/about");
  });

  it("marks an expired result and an updated one", () => {
    show(view({ company: { researchId: 7, expired: true, fields } }), question({ companyUpdated: true, selection: { ...question().selection, company: { researchId: 6, fields: ["summary"] } } }));
    expect(screen.getByTestId("writer-company-expired")).toBeInTheDocument();
    expect(screen.getByTestId("writer-company-updated")).toBeInTheDocument();
    // a tick of the older result does not show as ticked
    expect(within(screen.getByTestId("writer-company")).getAllByRole("checkbox")[0]).toHaveAttribute("aria-checked", "false");
  });

  it("saves a tick with the result it was made on", async () => {
    show(view());
    await userEvent.setup().click(screen.getAllByTestId("writer-company-field")[0]!);
    expect(actions.update.mock.calls[0]![0].selection.company).toEqual({ researchId: 7, fields: ["summary"] });
  });
});

describe("the fit note", () => {
  const ticked = () => question({ selection: { ...question().selection, company: { researchId: 7, fields: ["summary"] } } });

  it("asks only with a tick and a story", () => {
    show(view());
    expect(screen.getByTestId("writer-fit-button")).toBeDisabled();
  });

  it("adds the words of the story, not the AI's point, and only from a point that passed", async () => {
    show(view({ fit: { items: [item(), item({ companyPoint: "x", yourPoint: "You hold a PhD from MIT", status: "flagged", flags: ["your_point_unbacked"], missing: ["PhD", "MIT"] })], outdated: false, createdAt: "2026-11-01T00:00:00Z", openRequestId: null } }), ticked());
    const rows = screen.getAllByTestId("writer-fit-item");
    expect(within(rows[1]!).getByTestId("writer-fit-flags")).toHaveTextContent("PhD, MIT");
    expect(within(rows[1]!).queryByTestId("writer-fit-add")).toBeNull();
    await userEvent.setup().click(within(rows[0]!).getByTestId("writer-fit-add"));
    expect(actions.update.mock.calls[0]![0].selection.emphasis).toBe("migration of the billing service");
  });

  it("says when the emphasis note has no room", async () => {
    show(view({ limits: { emphasisMaxChars: 5 } as WorkbenchView["limits"], fit: { items: [item()], outdated: false, createdAt: "2026-11-01T00:00:00Z", openRequestId: null } }), ticked());
    await userEvent.setup().click(screen.getByTestId("writer-fit-add"));
    expect(actions.update).not.toHaveBeenCalled();
    expect(toasts.tone).toHaveBeenCalledWith("error", en.writer.materials.fit.emphasisFull);
  });

  it("marks a note that may be outdated", () => {
    show(view({ fit: { items: [item()], outdated: true, createdAt: "2026-11-01T00:00:00Z", openRequestId: null } }), ticked());
    expect(screen.getByTestId("writer-fit-outdated")).toBeInTheDocument();
  });
});
