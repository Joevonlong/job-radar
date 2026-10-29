import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobListItem } from "@/components/jobs/types";
import { Board } from "@/components/pipeline/board";
import { LiftedCard } from "@/components/pipeline/card";
import { HiddenStatusesProvider } from "@/components/applications/visibility-context";
import type { BoardCard } from "@/components/pipeline/types";
import { showsAppliedDate } from "@/lib/dashboard/board";
import type { BoardDensity } from "@/lib/dashboard/density";
import type { ApplicationStatus } from "@/lib/db/repos/applications";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const actions = vi.hoisted(() => ({
  setApplicationStatusAction: vi.fn(),
  undoApplicationStatusAction: vi.fn(),
  saveApplicationNotesAction: vi.fn(),
  saveNextActionAction: vi.fn(),
  setInterviewRoundsAction: vi.fn(),
}));
vi.mock("@/app/jobs/[id]/actions", () => ({ setApplicationStatusAction: actions.setApplicationStatusAction, saveApplicationNotesAction: actions.saveApplicationNotesAction }));
const toasts = vi.hoisted(() => ({ toastTone: vi.fn(), toastUndo: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastTone: toasts.toastTone, toastUndo: toasts.toastUndo }));
vi.mock("@/app/pipeline/actions", () => ({ saveNextActionAction: actions.saveNextActionAction, setInterviewRoundsAction: actions.setInterviewRoundsAction, undoApplicationStatusAction: actions.undoApplicationStatusAction }));

function job(id: number, company: string, title: string): JobListItem {
  return {
    id,
    title,
    companyName: company,
    locations: ["Berlin"],
    workplace: "hybrid",
    contract: "permanent",
    isAgency: false,
    germanLevelRequired: "none",
    jobStatus: "active",
    salaryDisclosed: false,
    salaryText: null,
    families: [],
    applicationStatus: null,
    rank: { rankValue: 80, score: 80, signalBonus: 0, filterResult: "passed", filterReasons: [], stale: false },
    signals: [],
    timeLabel: "",
    timeTitle: "",
  };
}

function card(id: number, company: string, status: ApplicationStatus, over: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId: id,
    job: job(id, company, `${company} role`),
    status,
    appliedDate: showsAppliedDate(status, null) ? "none" : null,
    statusDate: { iso: "2026-10-07T12:00:00.000Z", label: "Oct 7", full: "2026-10-07 14:00" },
    salary: null,
    overdue: null,
    clock: status === "interested" ? { kind: "interested", days: 2, limitDays: 7 } : status === "applied" ? { kind: "applied", days: 3, limitDays: 14 } : null,
    nextAction: null,
    nextActionDate: null,
    nextActionDateLabel: null,
    notes: "",
    interviewRounds: 0,
    events: [{ id: id * 10, when: "Oct 7, 2026, 12:00", from: null, to: status, note: null }],
    ...over,
  };
}

const CARDS: BoardCard[] = [
  card(1, "Alpha Labs", "interested", { overdue: { kind: "interested", days: 9 }, clock: { kind: "interested", days: 9, limitDays: 7 } }),
  card(2, "Beta Works", "applied", { overdue: { kind: "applied", days: 20 }, clock: { kind: "applied", days: 20, limitDays: 14 }, nextAction: "Follow up by email", nextActionDate: "2026-10-09", nextActionDateLabel: "Oct 9" }),
  card(3, "Gamma Systems", "preparing"),
  card(4, "Delta Corp", "interviewing", { interviewRounds: 2 }),
  card(5, "Epsilon Inc", "rejected"),
  card(6, "Zeta GmbH", "archived"),
];

function renderBoard(cards: BoardCard[] = CARDS, locale: "en" | "zh" = "en", searchParams = "", hidden: string[] = [], density: BoardDensity = "compact") {
  const Adapter = withNuqsTestingAdapter({ searchParams });
  const wrap = (node: ReactNode) => (
    <Adapter>
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
        {node}
      </NextIntlClientProvider>
    </Adapter>
  );
  return render(
    wrap(
      <HiddenStatusesProvider hidden={hidden}>
        <Board density={density} compact={{ title_lines: 2, next_action_lines: 1 }} rememberDays={30} cards={cards} pushLine={70} thresholds={{ interestedDays: 7, appliedDays: 14 }} />
      </HiddenStatusesProvider>,
    ),
  );
}

const columnOf = (status: string) => document.querySelector(`[data-testid="board-column"][data-column="${status}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  actions.setApplicationStatusAction.mockResolvedValue({ ok: true, previous: "preparing", status: "applied", changed: true });
  actions.setInterviewRoundsAction.mockResolvedValue({ ok: true, rounds: 3 });
  actions.saveNextActionAction.mockResolvedValue({ ok: true });
});

/** "Move to…": open the card's menu in the column and pick a status. */
async function moveWithMenu(column: string, status: ApplicationStatus) {
  await userEvent.click(within(columnOf(column)).getByTestId("card-status"));
  await userEvent.click(await screen.findByTestId(`card-move-${status}`));
}

describe("Board with hidden statuses", () => {
  it("drops the column of a hidden status without cards and folds one that still has cards", async () => {
    renderBoard(CARDS, "en", "", ["offer", "preparing"]);
    expect(columnOf("offer")).toBeNull();
    // "preparing" holds Gamma Systems: a narrow collapsed column, not a drop target
    const folded = columnOf("preparing");
    expect(folded).toHaveAttribute("data-hidden-column", "collapsed");
    expect(within(folded).queryByText("Gamma Systems")).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="drop-preparing"]')).toBeNull();
    expect(within(folded).getByTestId("hidden-toggle-preparing")).toHaveTextContent("hidden · 1");
    await userEvent.click(within(folded).getByTestId("hidden-toggle-preparing"));
    expect(within(columnOf("preparing")).getByText("Gamma Systems")).toBeInTheDocument();
  });

  it("does not list a hidden status in the move menu, except the card's own", async () => {
    renderBoard(CARDS, "en", "", ["offer", "preparing"]);
    await userEvent.click(within(columnOf("applied")).getByTestId("card-status"));
    expect(screen.queryByTestId("card-move-offer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-move-preparing")).not.toBeInTheDocument();
    expect(await screen.findByTestId("card-move-interviewing")).toBeInTheDocument();
  });

  it("lists the card's own hidden status, marked, so it can be moved on", async () => {
    renderBoard(CARDS, "en", "", ["preparing"]);
    await userEvent.click(within(columnOf("preparing")).getByTestId("hidden-toggle-preparing"));
    await userEvent.click(within(columnOf("preparing")).getByTestId("card-status"));
    expect(await screen.findByTestId("card-move-preparing")).toHaveTextContent("hidden");
    await userEvent.click(await screen.findByTestId("card-move-applied"));
    expect(actions.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 3, status: "applied" });
  });

  it("the ended column loses the drop zone of a hidden end state", async () => {
    renderBoard(CARDS, "en", "", ["withdrawn", "rejected"]);
    await userEvent.click(within(columnOf("ended")).getByTestId("ended-toggle"));
    expect(document.querySelector('[data-testid="drop-withdrawn"]')).toBeNull();
    expect(document.querySelector('[data-testid="drop-rejected"]')).toBeNull();
    expect(document.querySelector('[data-testid="drop-archived"]')).not.toBeNull();
    // the hidden status with a card is still listed (nothing can be dropped on it)
    expect(within(columnOf("ended")).getByText("Epsilon Inc")).toBeInTheDocument();
  });
});

describe("Board", () => {
  it("contains absolutely positioned card content in each active, hidden and ended column scroller", async () => {
    renderBoard(CARDS, "en", "", ["preparing"]);
    await userEvent.click(within(columnOf("preparing")).getByTestId("hidden-toggle-preparing"));
    await userEvent.click(within(columnOf("ended")).getByTestId("ended-toggle"));
    for (const status of ["interested", "preparing", "ended"]) {
      expect(within(columnOf(status)).getByTestId("column-scroll")).toHaveClass("relative", "overflow-y-auto");
    }
  });

  it("disables previous and next at the scroll ends and moves one column plus the gap", async () => {
    renderBoard();
    const board = screen.getByTestId("board");
    const prev = screen.getByTestId("board-prev");
    const next = screen.getByTestId("board-next");
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled(); // jsdom starts without layout or overflow
    Object.defineProperties(board, { clientWidth: { value: 500 }, scrollWidth: { value: 1250 } });
    board.style.columnGap = "12px";
    const first = columnOf("new");
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 240, 400));
    board.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === "object") board.scrollLeft = Math.max(0, Math.min(750, options.left ?? 0));
      fireEvent.scroll(board);
    });
    fireEvent.scroll(board);
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
    await userEvent.click(next);
    expect(board.scrollTo).toHaveBeenLastCalledWith({ left: 252, behavior: "instant" });
    expect(prev).toBeEnabled();
    await userEvent.click(next);
    await userEvent.click(next);
    expect(next).toBeDisabled();
    await userEvent.click(prev);
    expect(next).toBeEnabled();
    await userEvent.click(prev);
    await userEvent.click(prev);
    expect(prev).toBeDisabled();
  });

  it("puts cards in their columns; the three end states share a collapsed column", async () => {
    renderBoard();
    expect(within(columnOf("interested")).getByText("Alpha Labs")).toBeInTheDocument();
    expect(within(columnOf("applied")).getByText("Beta Works")).toBeInTheDocument();
    expect(within(columnOf("interviewing")).getByText("Delta Corp")).toBeInTheDocument();
    expect(within(columnOf("new")).getByText("No jobs")).toBeInTheDocument();
    const ended = columnOf("ended");
    expect(within(ended).getByTestId("column-count")).toHaveTextContent("2");
    expect(within(ended).queryByText("Epsilon Inc")).not.toBeInTheDocument();
    await userEvent.click(within(ended).getByTestId("ended-toggle"));
    expect(within(ended).getByText("Epsilon Inc")).toBeInTheDocument();
    expect(within(ended).getByText("Zeta GmbH")).toBeInTheDocument();
  });

  it("shows the overdue marker, the next step with its date and the interview rounds", () => {
    renderBoard();
    expect(within(columnOf("interested")).getByTestId("card-overdue")).toHaveTextContent("Interested for 9 days, not applied");
    const applied = columnOf("applied");
    expect(within(applied).getByTestId("card-overdue")).toHaveTextContent("Applied 20 days ago, no reply");
    expect(within(applied).getByText("Follow up by email")).toBeInTheDocument();
    expect(within(applied).getByTestId("card-next-date")).toHaveTextContent("Oct 9");
    expect(within(columnOf("interviewing")).getByTestId("card-rounds")).toHaveTextContent("Interview rounds: 2");
    expect(within(columnOf("preparing")).queryByTestId("card-overdue")).not.toBeInTheDocument();
    // a card without a next step of its own shows the status default
    expect(within(columnOf("preparing")).getByText("Finish tailored CV and apply")).toBeInTheDocument();
  });

  it("marks a starred job with a read-only star that assistive tech reads as favorited", () => {
    renderBoard([card(1, "Alpha Labs", "applied", { job: { ...job(1, "Alpha Labs", "Alpha Labs role"), favorite: true } }), card(2, "Beta Works", "applied")]);
    const [starred, plain] = [...document.querySelectorAll('[data-slot="pipeline-card"]')];
    expect(starred?.querySelector('[data-slot="fav-mark"]')).not.toBeNull();
    expect(starred?.querySelector('[data-slot="fav-mark"]')).toHaveTextContent("Favorited");
    expect(plain?.querySelector('[data-slot="fav-mark"]')).toBeNull();
  });

  it("draws the share of the pipeline per column and the days against the notify.yaml threshold on each card", () => {
    renderBoard();
    // 4 cards are in the flow (the 2 ended ones are not part of the shares): interested 1/4, applied 1/4, preparing 1/4, interviewing 1/4
    expect(within(columnOf("interested")).getByRole("meter", { name: "Share of the pipeline in Interested" })).toHaveAttribute("aria-valuetext", "25%");
    expect(within(columnOf("new")).getByRole("meter", { name: "Share of the pipeline in New" })).toHaveAttribute("aria-valuetext", "0%");

    const overdue = within(columnOf("interested")).getByTestId("card-overdue");
    const meter = within(overdue).getByRole("meter");
    // the scale is the notify.yaml threshold (7 days); the value is capped at it and the overrun is in the text
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "7");
    expect(meter).toHaveAttribute("aria-valuenow", "7");
    expect(meter).toHaveAttribute("aria-valuetext", "2 days over (limit 7 days)");
    expect(overdue).toHaveTextContent("2 days over");
  });

  it("a `new` card is part of the pipeline: its column holds the whole share (title, shares and badge count the same set)", () => {
    renderBoard([card(11, "Solo Co", "new")]);
    expect(within(columnOf("new")).getByRole("meter", { name: "Share of the pipeline in New" })).toHaveAttribute("aria-valuetext", "100%");
    expect(within(columnOf("new")).getByTestId("column-count")).toHaveTextContent("1");
  });

  it("a card that is not overdue shows its days and the limit, and no overdue marker", () => {
    renderBoard([card(9, "Omega Ltd", "applied")]);
    expect(screen.queryByTestId("card-overdue")).not.toBeInTheDocument();
    const meter = screen.getByRole("meter", { name: /Applied 3 days ago/ });
    expect(meter).toHaveAttribute("aria-valuenow", "3");
    expect(meter).toHaveAttribute("aria-valuemax", "14"); // the threshold itself
  });

  it("shows the salary as a yellow chip when stated and a dashed box when not", () => {
    const stated = card(7, "Stated Co", "preparing", { salary: { min: 85_000, max: 105_000, currency: "EUR", approx: false, otherRegion: false } });
    const converted = card(9, "Converted Co", "preparing", { salary: { min: 86_400, max: 86_400, currency: "EUR", approx: true, otherRegion: false } });
    renderBoard([stated, converted, card(8, "Hidden Co", "preparing")]);
    const [statedCard, convertedCard, hiddenCard] = screen.getAllByTestId("pipeline-card");
    expect(statedCard && within(statedCard).getByText("€85–105k")).toHaveAttribute("data-salary", "stated");
    // formatSalary: a converted figure leads with ≈ and is whole k
    expect(convertedCard && within(convertedCard).getByText("≈ €86k")).toBeInTheDocument();
    expect(hiddenCard && within(hiddenCard).getByText("Not disclosed")).toHaveAttribute("data-salary", "none");
  });

  it("counts the ended jobs per outcome without expanding", () => {
    renderBoard();
    const ended = columnOf("ended");
    expect(within(ended).getByRole("meter", { name: "Rejected: 1" })).toBeInTheDocument();
    expect(within(ended).getByRole("meter", { name: "Ignored: 1" })).toBeInTheDocument();
    expect(within(ended).getByRole("meter", { name: "Withdrawn: 0" })).toBeInTheDocument();
  });

  it("tilts the lifted card 3 degrees, and not at all with reduced motion", () => {
    const wrap = (node: ReactNode) => (
      <NextIntlClientProvider locale="en" messages={en}>
        {node}
      </NextIntlClientProvider>
    );
    const matchMedia = (matches: boolean) => vi.fn().mockImplementation((query: string) => ({ matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const original = window.matchMedia;
    try {
      window.matchMedia = matchMedia(false);
      const { unmount } = render(wrap(<LiftedCard density="comfortable" card={CARDS[0]!} pushLine={70} />));
      expect(screen.getByTestId("card-lifted").style.transform).toContain("rotate(-3deg)");
      unmount();
      window.matchMedia = matchMedia(true);
      render(wrap(<LiftedCard density="comfortable" card={CARDS[0]!} pushLine={70} />));
      expect(screen.getByTestId("card-lifted").style.transform).not.toContain("rotate(-3deg)");
    } finally {
      window.matchMedia = original;
    }
  });

  it("speaks Chinese", () => {
    renderBoard(CARDS, "zh");
    expect(within(columnOf("interested")).getByTestId("card-overdue")).toHaveTextContent("感兴趣 9 天未申请");
    expect(within(columnOf("ended")).getByText("已结束")).toBeInTheDocument();
  });

  it("filters by company or keyword, and to overdue cards only", async () => {
    renderBoard();
    await userEvent.type(screen.getByTestId("pipeline-search"), "gamma");
    expect(screen.getAllByTestId("pipeline-card")).toHaveLength(1);
    expect(screen.getByTestId("pipeline-count")).toHaveTextContent("Showing 1 of 6");
    await userEvent.click(screen.getByTestId("pipeline-filter-clear"));
    expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4); // the ended column is collapsed

    await userEvent.click(screen.getByTestId("overdue-toggle"));
    expect(screen.getByTestId("overdue-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("pipeline-card")).toHaveLength(2);
  });

  it("starts with the filters of the URL", () => {
    renderBoard(CARDS, "en", "?overdue=true&q=beta");
    expect(screen.getAllByTestId("pipeline-card")).toHaveLength(1);
    expect(screen.getByTestId("pipeline-search")).toHaveValue("beta");
  });

  it("moves a card with its status menu: one action call, the card moves at once", async () => {
    // keep the action pending: the cards prop only changes when the server has answered
    let finish: (value: unknown) => void = () => undefined;
    actions.setApplicationStatusAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderBoard();
    await moveWithMenu("preparing", "applied");
    expect(actions.setApplicationStatusAction).toHaveBeenCalledTimes(1);
    expect(actions.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 3, status: "applied" });
    expect(within(columnOf("applied")).getByText("Gamma Systems")).toBeInTheDocument();
    expect(within(columnOf("preparing")).queryByText("Gamma Systems")).not.toBeInTheDocument();
    await act(async () => finish({ ok: true, previous: "preparing", status: "applied", changed: true }));
  });

  it("confirms a move with a toast whose Undo puts the previous status back through the same action", async () => {
    actions.setApplicationStatusAction.mockResolvedValueOnce({ ok: true, previous: "preparing", status: "applied", changed: true });
    renderBoard();
    await moveWithMenu("preparing", "applied");
    expect(toasts.toastUndo).toHaveBeenCalledTimes(1);
    const [message, onUndo] = toasts.toastUndo.mock.calls[0] as [string, () => void];
    expect(message).toBe("Gamma Systems → Applied");

    // the Undo takes the move back (its event is removed) instead of writing a second status change
    actions.undoApplicationStatusAction.mockResolvedValueOnce({ ok: true, status: "preparing" });
    await act(async () => onUndo());
    expect(actions.undoApplicationStatusAction).toHaveBeenLastCalledWith({ jobId: 3, movedTo: "applied", restoreTo: "preparing" });
    expect(actions.setApplicationStatusAction).toHaveBeenCalledTimes(1);
    expect(toasts.toastTone).toHaveBeenLastCalledWith("success", "Undone: Gamma Systems → Preparing");
  });

  it("says nothing when a move wrote nothing (the card already had that status)", async () => {
    actions.setApplicationStatusAction.mockResolvedValueOnce({ ok: true, previous: "applied", status: "applied", changed: false });
    renderBoard();
    await moveWithMenu("preparing", "applied");
    expect(toasts.toastUndo).not.toHaveBeenCalled();
    expect(toasts.toastTone).not.toHaveBeenCalled();
  });

  it("shows applications in status `new` in the first column", () => {
    renderBoard([card(11, "Newco", "new"), ...CARDS]);
    expect(within(columnOf("new")).getByText("Newco")).toBeInTheDocument();
    expect(within(columnOf("new")).getByText("Decide if interested")).toBeInTheDocument();
  });

  it("gives every card a drag handle for the keyboard, and keeps Enter on the title and menu button for themselves", () => {
    renderBoard();
    const handle = within(columnOf("preparing")).getByTestId("card-handle");
    expect(handle).toHaveAttribute("aria-label", "Drag Gamma Systems");
    expect(handle).toHaveAttribute("aria-roledescription", "draggable");
    expect(handle).toHaveAttribute("aria-describedby");
    expect(handle.tabIndex).toBe(0);
    // the title and the menu are plain buttons: no drag attributes on them
    expect(within(columnOf("preparing")).getByTestId("card-open")).not.toHaveAttribute("aria-roledescription");
    expect(within(columnOf("preparing")).getByTestId("card-status")).not.toHaveAttribute("aria-roledescription");
  });

  it("opens the drawer from the title with Enter, and gives the focus back to the title on Escape", async () => {
    renderBoard();
    const title = within(columnOf("preparing")).getByTestId("card-open");
    title.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByTestId("card-drawer");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(within(columnOf("preparing")).getByTestId("card-open")).toHaveFocus());
  });

  it("reports a failed move", async () => {
    actions.setApplicationStatusAction.mockResolvedValue({ ok: false, error: "failed" });
    renderBoard();
    await moveWithMenu("preparing", "offer");
    expect(actions.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 3, status: "offer" });
    expect(toasts.toastTone).toHaveBeenCalledWith("error", expect.any(String));
    expect(toasts.toastUndo).not.toHaveBeenCalled();
  });

  it("shows an empty state with a link to the jobs list when nothing is in the pipeline", () => {
    renderBoard([]);
    expect(screen.getByTestId("pipeline-empty")).toHaveTextContent("No jobs in the pipeline yet");
    expect(screen.getByRole("link", { name: "Browse jobs" })).toHaveAttribute("href", "/jobs");
  });

  it("opens the drawer with the timeline, links to the job, and changes interview rounds", async () => {
    renderBoard();
    await userEvent.click(within(columnOf("interviewing")).getByTestId("card-open"));
    const drawer = await screen.findByTestId("card-drawer");
    expect(within(drawer).getByTestId("drawer-open-job")).toHaveAttribute("href", "/jobs/4");
    // the timeline is a terminal log: one line per status change
    expect(within(within(drawer).getByTestId("timeline")).getByRole("log").children).toHaveLength(1);
    expect(within(drawer).getByTestId("rounds-value")).toHaveTextContent("2");

    await act(async () => {
      await userEvent.click(within(drawer).getByTestId("rounds-plus"));
    });
    expect(actions.setInterviewRoundsAction).toHaveBeenCalledWith({ jobId: 4, rounds: 3 });
  });

  it("saves the next step and date from the drawer", async () => {
    renderBoard();
    await userEvent.click(within(columnOf("preparing")).getByTestId("card-open"));
    const drawer = await screen.findByTestId("card-drawer");
    await userEvent.type(within(drawer).getByTestId("next-action-input"), "Send CV");
    await userEvent.type(within(drawer).getByTestId("next-date-input"), "2026-12-24");
    await userEvent.click(within(drawer).getByTestId("next-action-save"));
    expect(actions.saveNextActionAction).toHaveBeenCalledWith({ jobId: 3, nextAction: "Send CV", nextActionDate: "2026-12-24" });
  });
});

describe("card dates and density", () => {
  const date = { iso: "2025-12-31T23:30:00.000Z", label: "Jan 1", full: "2026-01-01 00:30" };
  for (const density of ["compact", "comfortable"] as const) {
    it(`${density} preserves fields, hooks and meter semantics`, () => {
      const entry = card(12, "Aurora", "applied", { appliedDate: date, interviewRounds: 2, nextAction: "Send the complete research proposal", nextActionDateLabel: "Oct 9", overdue: { kind: "applied", days: 20 }, clock: { kind: "applied", days: 20, limitDays: 14 } });
      entry.job.favorite = true;
      entry.job.jobStatus = "closed";
      renderBoard([entry], "en", "", [], density);
      const article = document.querySelector('[data-slot="pipeline-card"]')!;
      expect(article).toHaveAttribute("data-density", density);
      const node = within(article as HTMLElement);
      for (const id of ["card-open", "card-handle", "card-status", "card-overdue", "card-next-date", "card-rounds", "card-dates", "card-applied-date", "card-status-date"]) expect(node.getByTestId(id)).toBeInTheDocument();
      for (const slot of ["fav-mark", "card-salary", "job-status-chip"]) expect(article.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
      expect(node.getByText("Aurora")).toBeInTheDocument();
      expect(node.getByText("Send the complete research proposal")).toHaveAttribute("title", "Send the complete research proposal");
      expect(node.getByTestId("card-open")).toHaveAttribute("title", entry.job.title);
      expect(article.querySelector('[data-slot="card-next"]')).toBeInTheDocument();
      expect(node.getByTestId("card-dates").tagName).toBe("DL");
      expect(node.getByTestId("card-applied-date").querySelector("time")).toHaveAttribute("datetime", date.iso);
      for (const [id, term, full, title, short] of [
        ["card-applied-date", "First marked applied", date.full, `First marked applied: ${date.full}`, `Applied ${date.label}`],
        ["card-status-date", "In this status since", "2026-10-07 14:00", "In this status since 2026-10-07 14:00", "Since Oct 7"],
      ] as const) {
        const field = node.getByTestId(id);
        expect(field.querySelector("dt")?.textContent).toBe(term);
        expect(field.querySelector("dt")).toHaveClass("sr-only");
        const time = field.querySelector("dd > time")!;
        expect(time).not.toHaveAttribute("aria-label");
        expect(time).toHaveAttribute("title", title);
        expect(within(time as HTMLElement).getByText(short)).toHaveAttribute("aria-hidden", "true");
        expect(within(time as HTMLElement).getByText(full)).toHaveClass("sr-only");
      }
      const meter = node.getByRole("meter", { name: "Applied 20 days ago, no reply" });
      expect(meter).toHaveAttribute("aria-valuetext", "6 days over (limit 14 days)");
      const rounds = node.getByTestId("card-rounds");
      expect(rounds.closest("dl")).toBeNull();
      const jobStatus = article.querySelector('[data-slot="job-status-chip"]')!;
      expect(jobStatus.closest("dl")).toBeNull();
      if (density === "compact") {
        const dateRow = node.getByTestId("card-dates").parentElement!;
        expect(dateRow).toHaveClass("flex");
        expect(rounds.parentElement?.parentElement).toBe(dateRow);
        expect(jobStatus.parentElement?.parentElement).toBe(dateRow);
        expect(dateRow.lastElementChild).toBe(rounds.parentElement);
      }
    });
  }

  it("renders a status date for all nine statuses and distinguishes absent applied history", () => {
    renderBoard((["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"] as const).map((status, i) => card(i + 20, `Company ${i}`, status)));
    fireEvent.click(screen.getByTestId("ended-toggle"));
    expect(screen.getAllByTestId("card-dates")).toHaveLength(9);
    expect(screen.getAllByTestId("card-status-date")).toHaveLength(9);
    expect(screen.getAllByTestId("card-applied-date")).toHaveLength(6);
    expect(screen.getAllByText("Not recorded")).toHaveLength(6);
  });

  it("retains a real applied date after returning to preparing", () => {
    renderBoard([card(1, "Aurora", "preparing", { appliedDate: date })]);
    expect(screen.getByTestId("card-applied-date").querySelector("time")).toHaveAttribute("datetime", date.iso);
  });

  it("changes density in this browser without calling any action", async () => {
    const cookie = vi.spyOn(document, "cookie", "set");
    renderBoard();
    await userEvent.click(within(screen.getByTestId("pipeline-density")).getByRole("radio", { name: "Comfortable" }));
    expect(screen.getByTestId("board")).toHaveAttribute("data-density", "comfortable");
    expect(cookie).toHaveBeenCalledWith("jr_board_density=comfortable; Path=/; Max-Age=2592000; SameSite=Lax");
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
    cookie.mockRestore();
  });

  it.each([null, "none"] as const)("first entry from %s has pending dates and a failed save restores the original status and dates", async (appliedDate) => {
    let finish: (value: unknown) => void = () => undefined;
    actions.setApplicationStatusAction.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderBoard([card(3, "Gamma", "preparing", { appliedDate, statusDate: date })]);
    await moveWithMenu("preparing", "applied");
    expect(screen.getAllByText("Saving…")).toHaveLength(2);
    expect(document.querySelector('[data-testid="card-dates"] time')).toBeNull();
    await act(async () => finish({ ok: false, error: "failed" }));
    expect(within(columnOf("preparing")).getByText("Gamma")).toBeInTheDocument();
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
    expect(screen.getByTestId("card-status-date").querySelector("time")).toHaveAttribute("datetime", date.iso);
    if (appliedDate === null) expect(screen.queryByTestId("card-applied-date")).not.toBeInTheDocument();
    else expect(screen.getByTestId("card-applied-date")).toHaveTextContent("Not recorded");
    expect(toasts.toastTone).toHaveBeenCalledWith("error", en.pipeline.error.failed);
  });

  it("keeps the recorded applied date while a move out of applied is saving", async () => {
    let finish: (value: unknown) => void = () => undefined;
    actions.setApplicationStatusAction.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderBoard([card(2, "Aurora", "applied", { appliedDate: date })]);
    await moveWithMenu("applied", "preparing");
    expect(screen.getByTestId("card-status-date")).toHaveTextContent("Saving…");
    expect(screen.getByTestId("card-applied-date").querySelector("time")).toHaveAttribute("datetime", date.iso);
    await act(async () => finish({ ok: false, error: "failed" }));
  });
});
