import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiRunStatus, formatElapsed } from "@/components/ai-run-status";
import { ClampedQuote } from "@/components/jobs/detail/clamped-quote";
import { CompPanel, type CompSignal } from "@/components/jobs/detail/comp-panel";
import { LanguageTag } from "@/components/jobs/detail/language-tag";
import { HiddenStatusesProvider } from "@/components/applications/visibility-context";
import { MarkAppliedButton } from "@/components/jobs/detail/mark-applied";
import { MobileActionBar } from "@/components/jobs/detail/mobile-action-bar";
import { NotesForm } from "@/components/jobs/detail/status-panel";
import { SourceIcon } from "@/components/jobs/source-icons";
import { findQuoteTerm } from "@/lib/signals/rules";

import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { defaultCategoryViews, shippedInterests } from "./signals/helpers";

const actions = vi.hoisted(() => ({ setStatus: vi.fn(), saveNotes: vi.fn(), markApplied: vi.fn(), undo: vi.fn() }));
vi.mock("@/app/jobs/[id]/actions", () => ({ setApplicationStatusAction: actions.setStatus, saveApplicationNotesAction: actions.saveNotes, markAppliedAction: actions.markApplied }));
vi.mock("@/app/pipeline/actions", () => ({ undoApplicationStatusAction: actions.undo }));
const toasts = vi.hoisted(() => ({ tone: vi.fn(), undo: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastTone: toasts.tone, toastUndo: toasts.undo }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  actions.setStatus.mockReset().mockResolvedValue({ ok: true, previous: null, status: "interested", changed: true });
  actions.saveNotes.mockReset().mockResolvedValue({ ok: true });
  actions.markApplied.mockReset().mockResolvedValue({ ok: true, previous: "interested", status: "applied", changed: true });
  actions.undo.mockReset().mockResolvedValue({ ok: true, status: "interested" });
  toasts.tone.mockReset();
  toasts.undo.mockReset();
});

const LONG =
  "What we offer: a friendly team, a modern office in the middle of the city, free coffee, a yearly company retreat and a competitive salary together with VSOP options for everyone who joins in the first year.";

describe("ClampedQuote", () => {
  const term = { start: LONG.indexOf("VSOP"), end: LONG.indexOf("VSOP") + 4 };

  it("shows a long quote as a window around its highlighted term, and the whole quote after 'Expand'", async () => {
    const user = userEvent.setup();
    render(<ClampedQuote text={LONG} term={term} color="teal" expandLabel="Expand" collapseLabel="Collapse" />);
    const text = screen.getByTestId("signal-quote-text");
    expect(text).toHaveClass("line-clamp-2");
    expect(screen.getByTestId("quote-term")).toHaveTextContent("VSOP");
    expect(text.textContent?.length ?? 0).toBeLessThan(LONG.length);
    expect(text.textContent).toContain("…");

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(text).not.toHaveClass("line-clamp-2");
    expect(text).toHaveTextContent(`“${LONG}”`);
    expect(screen.getByTestId("quote-term")).toHaveTextContent("VSOP");
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(text).toHaveClass("line-clamp-2");
  });

  it("starts at the beginning when the term is unknown and leaves a short quote alone, without a button", () => {
    const { rerender } = render(<ClampedQuote text={LONG} term={null} color="coral" expandLabel="Expand" collapseLabel="Collapse" />);
    expect(screen.getByTestId("signal-quote-text").textContent).toMatch(/^“What we offer/);
    expect(screen.queryByTestId("quote-term")).toBeNull();

    rerender(<ClampedQuote text="Competitive salary." term={{ start: 0, end: 11 }} color="coral" expandLabel="Expand" collapseLabel="Collapse" />);
    expect(screen.getByTestId("signal-quote-text")).toHaveTextContent("“Competitive salary.”");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("signal-quote-text")).not.toHaveClass("line-clamp-2");
  });
});

describe("CompPanel with long quotes", () => {
  const interests = shippedInterests();
  const signal = (id: number, over: Partial<CompSignal>): CompSignal => ({ id, tier: "T2", kind: "equity", value: null, quote: LONG, extractor: "rule", ...over });

  it("clamps every long quote, keeps its term in sight and offers 'Expand' per quote", () => {
    const quote = LONG;
    const term = findQuoteTerm(quote, "T2", interests);
    expect(term).not.toBeNull();
    render(
      wrap(
        <CompPanel
          salary={null}
          salaryDisclosed={false}
          signals={[signal(1, { term }), signal(2, { tier: "T3", kind: "competitive_pay", term: findQuoteTerm(quote, "T3", interests) })]}
          categories={defaultCategoryViews()}
          bonus={{ categories: [], sum: 0, bonus: 0, cap: 15, capped: false }}
          scan={{ aiReviewed: true }}
          language="en"
        />,
      ),
    );
    const items = screen.getAllByTestId("signal-item");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(within(item).getByTestId("signal-quote-text")).toHaveClass("line-clamp-2");
      expect(within(item).getByTestId("quote-term")).toBeInTheDocument();
      expect(within(item).getByRole("button", { name: "Expand" })).toBeInTheDocument();
    }
    expect(within(items[0] as HTMLElement).getByTestId("quote-term")).toHaveTextContent(/VSOP/i);
    expect(within(items[1] as HTMLElement).getByTestId("quote-term")).toHaveTextContent(/competitive salary/i);
  });
});

describe("CompPanel salary notes", () => {
  it("shows the OTE and other-region lines when the salary carries them", () => {
    render(
      wrap(
        <CompPanel
          salary={{ normalized: "€120–160k", raw: "OTE 120-160k", periodAssumed: false, includesVariable: true, otherRegion: { reason: "description", currency: null } }}
          salaryDisclosed
          signals={[]}
          categories={defaultCategoryViews()}
          bonus={{ categories: [], sum: 0, bonus: 0, cap: 15, capped: false }}
          scan={{ aiReviewed: true }}
          language="en"
        />,
      ),
    );
    expect(screen.getByText(en.signals.comp.includesVariable)).toBeInTheDocument();
    expect(screen.getByText(en.signals.comp.otherRegionDescription)).toBeInTheDocument();
  });
});

describe("findQuoteTerm", () => {
  const interests = shippedInterests();
  it("finds the amount of a T1 quote and the keyword of a T2 quote", () => {
    const t1 = "Salary: €85,000–105,000 per year plus benefits";
    const span = findQuoteTerm(t1, "T1", interests);
    expect(span).not.toBeNull();
    expect(t1.slice(span?.start, span?.end)).toContain("85,000");
    const t2 = "We grant stock options to everyone";
    const hit = findQuoteTerm(t2, "T2", interests);
    expect(t2.slice(hit?.start, hit?.end).toLowerCase()).toContain("stock options");
  });

  it("covers the whole stated range of a T1 quote, not only its first amount", () => {
    for (const quote of ["Compensation: €100,000.00/yr - €120,000.00/yr", "Salary range: EUR 85,000 to 105,000 per year", "Gehalt: 85.000 bis 105.000 EUR"]) {
      const span = findQuoteTerm(quote, "T1", interests);
      expect(span).not.toBeNull();
      const text = quote.slice(span?.start, span?.end);
      expect(text).toMatch(/(120,000|105,000|105\.000)/);
      expect(text).toMatch(/(100,000|85,000|85\.000)/);
    }
    // two amounts with words between them stay two amounts: only the first is the term
    const far = "Base €90,000 per year, plus a signing bonus of €20,000";
    expect(far.slice(findQuoteTerm(far, "T1", interests)?.start, findQuoteTerm(far, "T1", interests)?.end)).not.toContain("20,000");
  });

  it("is null for benefit tags and when nothing in the quote hits", () => {
    expect(findQuoteTerm("30 days of vacation", "tag", interests)).toBeNull();
    expect(findQuoteTerm("Nothing here", "T2", interests)).toBeNull();
  });
});

describe("MobileActionBar", () => {
  it("has the status select, the notes button and Apply in one fixed bar that is hidden from lg up", () => {
    render(wrap(<MobileActionBar jobId={7} status="interested" notes="" title="LLM Engineer" appliedOn={null} postingUrl="https://jobs.example.test/7" favorite={false} />));
    const bar = screen.getByTestId("mobile-action-bar");
    expect(bar).toHaveClass("fixed", "bottom-0", "lg:hidden");
    expect(within(bar).getByTestId("bar-status-select")).toHaveValue("interested");
    expect(within(bar).getByRole("button", { name: "Notes" })).toBeInTheDocument();
    expect(within(bar).getByTestId("bar-view-posting-button")).toHaveAttribute("href", "https://jobs.example.test/7");
  });

  it("saves a status change from the bar", async () => {
    const user = userEvent.setup();
    render(wrap(<MobileActionBar jobId={7} status="new" notes="" title="LLM Engineer" appliedOn={null} postingUrl={null} favorite={false} />));
    await user.selectOptions(screen.getByTestId("bar-status-select"), "applied");
    expect(actions.setStatus).toHaveBeenCalledWith({ jobId: 7, status: "applied" });
    expect(screen.queryByTestId("bar-view-posting-button")).toBeNull();
  });

  it("opens the notes in a sheet, saves them and closes it", async () => {
    const user = userEvent.setup();
    render(wrap(<MobileActionBar jobId={7} status="new" notes="call Anna" title="LLM Engineer" appliedOn={null} postingUrl={null} favorite={false} />));
    expect(screen.queryByTestId("bar-notes-input")).toBeNull();
    await user.click(screen.getByTestId("bar-notes-button"));
    const input = await screen.findByTestId("bar-notes-input");
    expect(input).toHaveValue("call Anna");
    await user.type(input, " tomorrow");
    await user.click(screen.getByTestId("bar-notes-save"));
    expect(actions.saveNotes).toHaveBeenCalledWith({ jobId: 7, notes: "call Anna tomorrow" });
    await waitFor(() => expect(screen.queryByTestId("bar-notes-input")).toBeNull());
  });
});

describe("NotesForm", () => {
  it("keeps the ids and test ids of the side panel by default", async () => {
    render(wrap(<NotesForm jobId={1} notes="" />));
    expect(screen.getByTestId("notes-input")).toHaveAttribute("id", "job-notes");
    expect(screen.getByTestId("notes-save")).toBeDisabled();
  });
});

describe("SourceIcon", () => {
  it("draws the LinkedIn logo instead of the letters 'in', named for assistive tech", () => {
    const { container } = render(wrap(<SourceIcon family="linkedin" />));
    const icon = container.querySelector("[data-slot=source-icon]");
    expect(icon?.querySelector("svg")).not.toBeNull();
    expect(icon?.textContent).toBe("LinkedIn");
    expect(screen.queryByText("in")).toBeNull();
  });

  it("draws a building for a company's own job board instead of 'AT'", () => {
    const { container } = render(wrap(<SourceIcon family="ats" />));
    expect(container.querySelector("[data-slot=source-icon] svg")).not.toBeNull();
    expect(screen.queryByText("AT")).toBeNull();
    expect(screen.getByText("Company ATS")).toBeInTheDocument();
  });
});

describe("LanguageTag", () => {
  it("tags text with its language", () => {
    render(<LanguageTag lang="zh" label="中文" title="hint" />);
    const tag = screen.getByTestId("language-tag");
    expect(tag).toHaveTextContent("中文");
    expect(tag).toHaveAttribute("lang", "zh");
  });
});

describe("AiRunStatus", () => {
  it("says AI is processing, for which cycle, with what it has produced and how long it took", () => {
    render(wrap(<AiRunStatus status="running" cycleId={12} elapsedSeconds={75} scored={4} translated={1} />));
    expect(screen.getByTestId("ai-run-status")).toHaveAttribute("data-status", "running");
    expect(screen.getByText("AI processing")).toBeInTheDocument();
    expect(screen.getByTestId("ai-run-progress")).toHaveTextContent("Cycle 12 · 4 scored · 1 translated · 1:15 so far");
  });

  it("says it is queued while the ai-worker has not taken it, and speaks Chinese", () => {
    render(wrap(<AiRunStatus status="pending" cycleId={null} elapsedSeconds={5} scored={0} translated={0} />, "zh"));
    expect(screen.getByText("AI 排队中")).toBeInTheDocument();
    expect(screen.getByTestId("ai-run-progress")).toHaveTextContent("已等待 0:05");
    expect(screen.getByRole("link", { name: "查看 ai-worker" })).toHaveAttribute("href", "/sources");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59)).toBe("0:59");
    expect(formatElapsed(3725)).toBe("1:02:05");
  });
});

describe("MarkAppliedButton", () => {
  const render1 = (status: Parameters<typeof MarkAppliedButton>[0]["status"], appliedOn: string | null = null) =>
    render(wrap(<MarkAppliedButton jobId={7} title="LLM Engineer" status={status} appliedOn={appliedOn} variant="header" />));

  it.each(["new", "interested", "preparing", "archived"] as const)("shows the button for %s", (status) => {
    render1(status);
    expect(screen.getByTestId("mark-applied-button")).toBeEnabled();
    expect(screen.queryByTestId("applied-display")).toBeNull();
  });

  it("is not offered while 'applied' is hidden in ui.yaml", () => {
    render(wrap(<HiddenStatusesProvider hidden={["applied"]}><MarkAppliedButton jobId={7} title="LLM Engineer" status="interested" appliedOn={null} variant="header" /></HiddenStatusesProvider>));
    expect(screen.queryByTestId("mark-applied-button")).toBeNull();
  });

  it("shows the date once applied, and only the status name further along; no button either way", () => {
    const { unmount } = render1("applied", "Oct 8");
    expect(screen.getByTestId("applied-display")).toHaveTextContent("Applied · Oct 8");
    expect(screen.queryByTestId("mark-applied-button")).toBeNull();
    unmount();
    render1("interviewing");
    expect(screen.getByTestId("applied-display")).toHaveTextContent("Interviewing");
    expect(screen.queryByTestId("mark-applied-button")).toBeNull();
  });

  it("marks applied on click and offers an undo that restores the previous status", async () => {
    const user = userEvent.setup();
    render1("interested");
    await user.click(screen.getByTestId("mark-applied-button"));
    expect(actions.markApplied).toHaveBeenCalledWith({ jobId: 7 });
    await waitFor(() => expect(toasts.undo).toHaveBeenCalledTimes(1));
    expect(toasts.undo.mock.calls[0]?.[0]).toBe("Marked as applied: LLM Engineer");
    await (toasts.undo.mock.calls[0]?.[1] as () => Promise<void>)();
    expect(actions.undo).toHaveBeenCalledWith({ jobId: 7, movedTo: "applied", restoreTo: "interested" });
  });

  it("restores to new when there was no application", async () => {
    actions.markApplied.mockResolvedValue({ ok: true, previous: null, status: "applied", changed: true });
    const user = userEvent.setup();
    render1("new");
    await user.click(screen.getByTestId("mark-applied-button"));
    await waitFor(() => expect(toasts.undo).toHaveBeenCalled());
    await (toasts.undo.mock.calls[0]?.[1] as () => Promise<void>)();
    expect(actions.undo).toHaveBeenCalledWith({ jobId: 7, movedTo: "applied", restoreTo: "new" });
  });

  it("says so without an undo when it was already applied", async () => {
    actions.markApplied.mockResolvedValue({ ok: true, previous: "applied", status: "applied", changed: false });
    const user = userEvent.setup();
    render1("new");
    await user.click(screen.getByTestId("mark-applied-button"));
    await waitFor(() => expect(toasts.tone).toHaveBeenCalledWith("info", "Already marked as applied"));
    expect(toasts.undo).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-enables the button on failure", async () => {
    actions.markApplied.mockResolvedValue({ ok: false, error: "failed" });
    const user = userEvent.setup();
    render1("new");
    await user.click(screen.getByTestId("mark-applied-button"));
    await waitFor(() => expect(toasts.tone).toHaveBeenCalledWith("error", "Could not save, please retry"));
    expect(screen.getByTestId("mark-applied-button")).toBeEnabled();
  });

  it("View posting is a plain link: rendering and clicking it calls no action", async () => {
    const user = userEvent.setup();
    render(wrap(<MobileActionBar jobId={7} status="new" notes="" title="LLM Engineer" appliedOn={null} postingUrl="https://jobs.example.test/7" favorite={false} />));
    const link = screen.getByTestId("bar-view-posting-button");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    link.addEventListener("click", (e) => e.preventDefault());
    await user.click(link);
    expect(actions.markApplied).not.toHaveBeenCalled();
    expect(actions.setStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId("bar-mark-applied-button")).toBeInTheDocument();
  });
});
