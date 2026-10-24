import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JobList } from "@/components/jobs/job-list";
import type { JobListViz } from "@/components/jobs/job-list";
import type { JobListItem } from "@/components/jobs/types";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";

import en from "../messages/en.json";

const mocks = vi.hoisted(() => ({
  setApplicationStatusAction: vi.fn(),
  undoApplicationStatusAction: vi.fn(),
  setFavoriteAction: vi.fn(),
  restoreFavoriteAction: vi.fn(),
  toastTone: vi.fn(),
  toastUndo: vi.fn(),
  push: vi.fn(),
  markSeenAction: vi.fn(),
  markUnseenAction: vi.fn(),
  closeJobAction: vi.fn(),
  reopenJobAction: vi.fn(),
  undoClosureAction: vi.fn(),
}));
vi.mock("@/app/jobs/closure-actions", () => ({ closeJobAction: mocks.closeJobAction, reopenJobAction: mocks.reopenJobAction, undoClosureAction: mocks.undoClosureAction }));
vi.mock("@/app/jobs/[id]/actions", () => ({ setApplicationStatusAction: mocks.setApplicationStatusAction }));
vi.mock("@/app/pipeline/actions", () => ({ undoApplicationStatusAction: mocks.undoApplicationStatusAction }));
vi.mock("@/app/favorites/actions", () => ({ setFavoriteAction: mocks.setFavoriteAction, restoreFavoriteAction: mocks.restoreFavoriteAction }));
vi.mock("@/app/visit-actions", () => ({ markSeenAction: mocks.markSeenAction, markUnseenAction: mocks.markUnseenAction }));
vi.mock("@/lib/toast", () => ({ toastTone: mocks.toastTone, toastUndo: mocks.toastUndo }));
vi.mock("@/components/jobs/job-view-transition", async () => {
  const { jobViewTransitionName } = await import("@/components/jobs/view-transition");
  return { JobViewTransition: ({ id, part, children }: { id: number; part: "title" | "score"; children: React.ReactNode }) => <div data-vt-name={jobViewTransitionName(id, part)}>{children}</div> };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: vi.fn() }) }));

const job = (id: number, over: Partial<JobListItem> = {}): JobListItem => ({
  id,
  title: `Job ${id}`,
  companyName: `Company ${id}`,
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
  ...over,
});

const viz: JobListViz = {
  pushLine: 70,
  bonusCap: 15,
  floor: 70_000,
  salaryAxis: { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" },
  freshness: { decayHours: 72, warnHours: 24 },
  nowIso: "2026-10-08T12:00:00.000Z",
  timezone: "Europe/Berlin",
};

const list = (jobs: JobListItem[], mode?: "favorites") => (
  <NextIntlClientProvider locale="en" messages={en}>
    <JobList jobs={jobs} label="Jobs" empty="none" viz={viz} {...(mode ? { mode } : {})} />
  </NextIntlClientProvider>
);

const focusedJob = () => document.activeElement?.closest("[data-job-id]")?.getAttribute("data-job-id") ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn(); // jsdom does not implement it
  mocks.setApplicationStatusAction.mockResolvedValue({ ok: true, previous: null, status: "archived", changed: true });
  mocks.setFavoriteAction.mockResolvedValue({ ok: true, favorite: true, changed: true, removed: null });
  mocks.restoreFavoriteAction.mockResolvedValue({ ok: true });
  mocks.markSeenAction.mockResolvedValue({ ok: true, changed: true });
  mocks.markUnseenAction.mockResolvedValue({ ok: true, changed: true });
  mocks.closeJobAction.mockResolvedValue({ ok: true, previous: null });
  mocks.reopenJobAction.mockResolvedValue({ ok: true, previous: { action: "closed", note: "n", createdAt: "2026-10-09T08:00:00.000Z" } });
  mocks.undoClosureAction.mockResolvedValue({ ok: true });
  window.sessionStorage.clear();
});

describe("JobList: ignoring a job with x", () => {
  it("moves the focus to the next row, which is still there when the ignored row leaves the list", async () => {
    const user = userEvent.setup();
    const { rerender } = render(list([job(1), job(2), job(3), job(4)]));
    await user.keyboard("jj");
    expect(focusedJob()).toBe("2");

    await user.keyboard("x");
    await waitFor(() => expect(focusedJob()).toBe("3"));
    expect(mocks.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 2, status: "archived" });

    // Today re-renders without the ignored job: the focus stays on the row it moved to
    await act(async () => rerender(list([job(1), job(3), job(4)])));
    expect(focusedJob()).toBe("3");
    // and the keyboard carries on from there
    await user.keyboard("j");
    expect(focusedJob()).toBe("4");
  });

  it("falls back to the previous row when the ignored one was the last", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2), job(3)]));
    await user.keyboard("jjj");
    expect(focusedJob()).toBe("3");
    await user.keyboard("x");
    await waitFor(() => expect(focusedJob()).toBe("2"));
  });

  it("keeps the focus where it is when the change fails, and says so", async () => {
    mocks.setApplicationStatusAction.mockResolvedValue({ ok: false, error: "failed" });
    const user = userEvent.setup();
    render(list([job(1), job(2), job(3)]));
    await user.keyboard("jj");
    await user.keyboard("x");
    await waitFor(() => expect(mocks.toastTone).toHaveBeenCalledWith("error", "Could not save, please retry"));
    expect(focusedJob()).toBe("2");
  });

  it("offers an undo in the toast that puts the previous status back", async () => {
    mocks.setApplicationStatusAction.mockResolvedValue({ ok: true, previous: "interested", status: "archived", changed: true });
    const user = userEvent.setup();
    render(list([job(1, { applicationStatus: "interested" }), job(2)]));
    await user.keyboard("j");
    await user.keyboard("x");
    await waitFor(() => expect(mocks.toastUndo).toHaveBeenCalled());
    const [message, onUndo, options] = mocks.toastUndo.mock.calls[0] as [string, () => Promise<void>, { label: string }];
    expect(message).toBe("Ignored: Job 1");
    expect(options.label).toBe("Undo");
    await onUndo();
    // the undo takes the ignore back: its event and clock go, a row the ignore created is removed again
    expect(mocks.undoApplicationStatusAction).toHaveBeenLastCalledWith({ jobId: 1, movedTo: "archived", restoreTo: "interested" });
  });

  it("x on an already ignored job brings it back instead", async () => {
    mocks.setApplicationStatusAction.mockResolvedValue({ ok: true, previous: "archived", status: "new", changed: true });
    const user = userEvent.setup();
    render(list([job(1, { applicationStatus: "archived" }), job(2)]));
    await user.keyboard("jx");
    await waitFor(() => expect(mocks.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 1, status: "new" }));
  });
});

describe("JobList: undoing an ignore", () => {
  it("puts the focus back on the restored row once it is in the list again", async () => {
    mocks.setApplicationStatusAction.mockResolvedValue({ ok: true, previous: null, status: "archived", changed: true });
    mocks.undoApplicationStatusAction.mockResolvedValue({ ok: true, status: null });
    const user = userEvent.setup();
    const { rerender } = render(list([job(1), job(2), job(3)]));
    await user.keyboard("jj");
    await user.keyboard("x");
    await waitFor(() => expect(focusedJob()).toBe("3"));
    await act(async () => rerender(list([job(1), job(3)])));
    const [, onUndo] = mocks.toastUndo.mock.calls[0] as [string, () => Promise<void>];
    await act(async () => {
      await onUndo();
    });
    // the page refreshes with the job back in place
    await act(async () => rerender(list([job(1), job(2), job(3)])));
    await waitFor(() => expect(focusedJob()).toBe("2"));
  });
});

describe("JobList: rows that leave the list", () => {
  it("are out of the list at once while their exit animation still runs: marked and inert", async () => {
    const { rerender } = render(list([job(1), job(2), job(3)]));
    rerender(list([job(1), job(2)]));
    // the exit animation keeps the old row in the DOM for a while (on a busy machine for as long as frames are late)
    const leaving = document.querySelector('[data-job-id="3"]')?.closest("li");
    expect(leaving).not.toBeNull();
    expect(leaving).toHaveAttribute("data-leaving", "true");
    expect(leaving).toHaveAttribute("inert");
    // inert already hides it from assistive tech; aria-hidden on a row that may still hold the focus makes Chrome warn
    expect(leaving).not.toHaveAttribute("aria-hidden");
    // the list as a user (or a test) sees it holds only the rows of the new list
    // (Testing Library does not model inert, which takes the row out of the accessibility tree in a browser: leave it out here)
    const reachable = screen.getAllByRole("group").filter((row) => row.closest("[inert]") === null);
    expect(reachable.map((row) => row.getAttribute("data-job-id"))).toEqual(["1", "2"]);
    expect(document.querySelectorAll('[data-testid="job-list"] > li:not([data-leaving]) [data-job-id]')).toHaveLength(2);
    for (const id of ["1", "2"]) expect(document.querySelector(`[data-job-id="${id}"]`)?.closest("li")).not.toHaveAttribute("data-leaving");
    await waitFor(() => expect(document.querySelector('[data-job-id="3"]')).toBeNull());
  });

  it("come back as ordinary rows when they return during their exit (an undo)", async () => {
    const { rerender } = render(list([job(1), job(2), job(3)]));
    rerender(list([job(1), job(2)]));
    const leaving = document.querySelector('[data-job-id="3"]')?.closest("li");
    expect(leaving).toHaveAttribute("data-leaving", "true");
    // the undo puts the job back before the exit animation is over: the same list item stays, in the list again
    rerender(list([job(1), job(2), job(3)]));
    const back = document.querySelector('[data-job-id="3"]')?.closest("li");
    expect(back).toBe(leaving);
    await waitFor(() => expect(back).not.toHaveAttribute("data-leaving"));
    expect(back).not.toHaveAttribute("inert");
    expect(document.querySelectorAll('[data-testid="job-list"] > li:not([data-leaving]) [data-job-id]')).toHaveLength(3);
    // and it is not removed when the cancelled exit would have ended
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('[data-job-id="3"]')?.closest("li")).toBe(back);
    expect(back).not.toHaveAttribute("data-leaving");
  });

  it("are skipped by the keyboard focus even when they still carry the row index of the row that took their place", async () => {
    const user = userEvent.setup();
    const { rerender } = render(list([job(1), job(2), job(3)]));
    await user.keyboard("j");
    expect(focusedJob()).toBe("1");
    // job 2 leaves: while it plays its exit it still says data-row-index="1", and so does job 3, which is now the second row
    await act(async () => rerender(list([job(1), job(3)])));
    const leaving = document.querySelector('[data-job-id="2"]');
    expect(leaving?.closest("li")).toHaveAttribute("data-leaving", "true");
    expect(leaving).toHaveAttribute("data-row-index", "1");
    expect(document.querySelector('[data-job-id="3"]')).toHaveAttribute("data-row-index", "1");
    // j moves to the second row of the list: job 3, not the leaving job 2 that comes first in the DOM
    await user.keyboard("j");
    expect(focusedJob()).toBe("3");
  });
});

describe("JobList: rows", () => {
  it("labels an unseen row for assistive tech and flags it", () => {
    render(list([job(1, { seen: false, isNew: true }), job(2, { seen: true })]));
    expect(screen.getByRole("group", { name: "Unseen: Job 1, Company 1" })).toHaveAttribute("data-seen", "false");
    expect(screen.getByRole("group", { name: "Job 2, Company 2" })).toHaveAttribute("data-seen", "true");
    expect(screen.getByRole("link", { name: "Job 1" })).toHaveAttribute("href", "/jobs/1");
  });

  it("shows the AI summary on one truncated line under the company, when there is one", () => {
    render(list([job(1, { summary: "A Berlin startup hires its first FDE to ship LLM agents." }), job(2)]));
    const summary = document.querySelector('[data-job-id="1"] [data-slot="job-summary"]');
    expect(summary).toHaveTextContent("first FDE");
    expect(summary).toHaveAttribute("title", expect.stringContaining("first FDE"));
    expect(document.querySelector('[data-job-id="2"] [data-slot="job-summary"]')).toBeNull();
  });

  it("puts a dot in front of an unseen title and no NEW tag anywhere (the dot replaces it)", () => {
    render(list([job(1, { seen: false, isNew: true }), job(2, { isNew: true })]));
    expect(document.querySelector('[data-job-id="1"] [data-slot="unseen-dot"]')).toBeInTheDocument();
    expect(document.querySelector('[data-job-id="2"] [data-slot="unseen-dot"]')).toBeNull();
    expect(document.querySelector('[data-slot="new-dot"]')).toBeNull();
    expect(screen.queryByText("NEW")).toBeNull();
  });

  it("shows — for a job without skills, never 0/0, and a meter for one with skills", () => {
    render(list([job(1), job(2, { skills: ["Python", "AWS"], skillHits: ["Python"] })]));
    const none = document.querySelector('[data-job-id="1"] [data-slot="skills-none"]');
    expect(none).toHaveTextContent("—");
    expect(document.querySelector('[data-job-id="1"]')).not.toHaveTextContent("0/0");
    expect(document.querySelector('[data-job-id="2"]')).toHaveTextContent("1/2");
  });

  it("draws the salary state of each row: stated, undisclosed", () => {
    render(list([job(1, { salaryDisclosed: true, salaryText: "€90–110k", salaryMin: 90_000, salaryMax: 110_000, salaryPercentile: 72 }), job(2)]));
    const stated = document.querySelector('[data-job-id="1"] [data-salary-state]');
    expect(stated).toHaveAttribute("data-salary-state", "stated");
    expect(stated).toHaveTextContent("Above 72% of disclosed jobs");
    expect(document.querySelector('[data-job-id="2"] [data-salary-state]')).toHaveAttribute("data-salary-state", "none");
  });

  it("wraps the title and the score in the shared elements of the detail page (React <ViewTransition>, the same names)", () => {
    render(list([job(7)]));
    const row = document.querySelector('[data-job-id="7"]') as HTMLElement;
    // the stub of the mock above shows the name the row gives each shared element
    expect(row.querySelector('[data-vt-name="job-7-title"] a')).not.toBeNull();
    expect(row.querySelector('[data-vt-name="job-7-score"] [role="meter"], [data-vt-name="job-7-score"] [role="img"]')).not.toBeNull();
    // never as an inline style: React sets the name itself while a transition runs, a fixed one would never pair
    expect(row.querySelector("[style*='view-transition-name']")).toBeNull();
  });
});

describe("JobList: the ★ 👍 ✕ buttons", () => {
  it("are real buttons in the row and do what s and x do", async () => {
    mocks.setApplicationStatusAction.mockResolvedValue({ ok: true, previous: null, status: "interested", changed: true });
    const user = userEvent.setup();
    render(list([job(1), job(2)]));
    await user.click(screen.getAllByRole("button", { name: "Mark as interested: Job 1" })[0] as HTMLElement);
    await waitFor(() => expect(mocks.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 1, status: "interested" }));
    // S can be taken back like X: the same Undo, which removes the move and its clock
    await waitFor(() => expect(mocks.toastUndo).toHaveBeenCalled());
    const [message, onUndo, options] = mocks.toastUndo.mock.calls[0] as [string, () => Promise<void>, { label: string }];
    expect(message).toBe("Marked interested: Job 1");
    expect(options.label).toBe("Undo");
    await onUndo();
    expect(mocks.undoApplicationStatusAction).toHaveBeenLastCalledWith({ jobId: 1, movedTo: "interested", restoreTo: "new" });
  });

  it("ignoring through the button offers the undo toast too", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2)]));
    await user.click(screen.getByRole("button", { name: "Ignore: Job 2" }));
    await waitFor(() => expect(mocks.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 2, status: "archived" }));
    await waitFor(() => expect(mocks.toastUndo).toHaveBeenCalled());
  });

  it("only the active row's buttons are tab stops; Enter on a button does not open the job", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2)]));
    expect(screen.getByRole("button", { name: "Ignore: Job 1" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Ignore: Job 2" })).toHaveAttribute("tabindex", "-1");
    screen.getByRole("button", { name: "Ignore: Job 1" }).focus();
    await user.keyboard("{Enter}");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("Enter on the focused row opens the job", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2)]));
    await user.keyboard("j");
    await user.keyboard("{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/jobs/1");
  });
});

describe("JobList: the company name", () => {
  it("links to the list of that company's jobs only, and is a tab stop of the active row only", () => {
    render(list([job(1, { companyName: "AT&T, Inc." }), job(2)]));
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("data-slot") === "company-link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/jobs?company=AT%26T%2C+Inc.", "/jobs?company=Company+2"]);
    expect(links[0]).toHaveTextContent("AT&T, Inc.");
    expect(links[0]).toHaveAttribute("tabindex", "0");
    expect(links[1]).toHaveAttribute("tabindex", "-1");
  });

  it("a click on it neither opens the job nor counts as opening it", async () => {
    render(list([job(1), job(2)]));
    const link = screen.getByRole("link", { name: "Company 1" });
    // jsdom cannot navigate: keep the click from trying
    link.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("jr:list-return")).toBeNull();
    // the title link still counts as opening
    const title = screen.getByRole("link", { name: "Job 1" });
    title.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(title);
    expect(window.sessionStorage.getItem("jr:list-return")).toContain('"jobId":1');
  });

  it("Enter on the focused company link does not open the job", async () => {
    const user = userEvent.setup();
    render(list([job(1)]));
    const link = screen.getByRole("link", { name: "Company 1" });
    link.addEventListener("click", (event) => event.preventDefault());
    link.focus();
    await user.keyboard("{Enter}");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("a name too long for a filter value stays plain text", () => {
    render(list([job(1, { companyName: "N".repeat(MAX_FILTER_VALUE_CHARS + 1) })]));
    expect(screen.queryAllByRole("link").filter((a) => a.getAttribute("data-slot") === "company-link")).toHaveLength(0);
    expect(screen.getByText("N".repeat(MAX_FILTER_VALUE_CHARS + 1)).tagName).toBe("B");
  });
});

describe("JobList: favorites", () => {
  const removed = { note: "ask about visa", createdAt: "2026-10-01T10:00:00.000Z" };

  it("the ★ button stars the job at once, calls the action with a set value, and toasts", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2)]));
    const star = screen.getAllByRole("button", { name: "Favorite: Job 1" })[0] as HTMLElement;
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Favorited", { selector: "[data-slot=fav-mark] .sr-only" })).toBeNull();
    await user.click(star);
    await waitFor(() => expect(mocks.setFavoriteAction).toHaveBeenCalledWith({ jobId: 1, favorite: true }));
    expect(screen.getByRole("button", { name: "Remove from favorites: Job 1" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-job-id="1"] [data-slot="fav-mark"]')).not.toBeNull();
    await waitFor(() => expect(mocks.toastTone).toHaveBeenCalledWith("success", "Favorited: Job 1"));
    // the application status was not touched
    expect(mocks.setApplicationStatusAction).not.toHaveBeenCalled();
  });

  it("f toggles the focused row; s and x keep their meaning", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2)]));
    await user.keyboard("j");
    await user.keyboard("f");
    await waitFor(() => expect(mocks.setFavoriteAction).toHaveBeenCalledWith({ jobId: 1, favorite: true }));
    await user.keyboard("s");
    await waitFor(() => expect(mocks.setApplicationStatusAction).toHaveBeenCalledWith({ jobId: 1, status: "interested" }));
    mocks.setFavoriteAction.mockResolvedValue({ ok: true, favorite: false, changed: true, removed });
    await user.keyboard("f");
    await waitFor(() => expect(mocks.setFavoriteAction).toHaveBeenLastCalledWith({ jobId: 1, favorite: false }));
  });

  it("puts the star back and shows an error toast when the server fails", async () => {
    mocks.setFavoriteAction.mockResolvedValue({ ok: false, error: "failed" });
    const user = userEvent.setup();
    render(list([job(1)]));
    await user.click(screen.getByRole("button", { name: "Favorite: Job 1" }));
    await waitFor(() => expect(mocks.toastTone).toHaveBeenCalledWith("error", "Could not save, try again"));
    expect(screen.getByRole("button", { name: "Favorite: Job 1" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector('[data-slot="fav-mark"]')).toBeNull();
  });

  it("un-starring offers an undo that restores the note and time", async () => {
    mocks.setFavoriteAction.mockResolvedValue({ ok: true, favorite: false, changed: true, removed });
    const user = userEvent.setup();
    render(list([job(1, { favorite: true })]));
    expect(document.querySelector('[data-slot="fav-mark"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove from favorites: Job 1" }));
    await waitFor(() => expect(mocks.toastUndo).toHaveBeenCalled());
    const [message, onUndo] = mocks.toastUndo.mock.calls[0] as [string, () => Promise<void>];
    expect(message).toBe("Removed from favorites: Job 1");
    await act(async () => {
      await onUndo();
    });
    expect(mocks.restoreFavoriteAction).toHaveBeenCalledWith({ jobId: 1, ...removed });
    expect(screen.getByRole("button", { name: "Remove from favorites: Job 1" })).toHaveAttribute("aria-pressed", "true");
  });

  it("on the favorites page an un-starred row leaves and the focus goes to the neighbour; undo brings it back", async () => {
    mocks.setFavoriteAction.mockResolvedValue({ ok: true, favorite: false, changed: true, removed });
    const user = userEvent.setup();
    render(list([job(1, { favorite: true }), job(2, { favorite: true }), job(3, { favorite: true })], "favorites"));
    await user.keyboard("j");
    await user.keyboard("j");
    expect(focusedJob()).toBe("2");
    await user.keyboard("f");
    await waitFor(() => expect(document.querySelector('[data-job-id="2"]')).toBeNull());
    await waitFor(() => expect(focusedJob()).toBe("3"));
    const [, onUndo] = mocks.toastUndo.mock.calls[0] as [string, () => Promise<void>];
    await act(async () => {
      await onUndo();
    });
    await waitFor(() => expect(document.querySelector('[data-job-id="2"]')).not.toBeNull());
  });

  it("ignores a second press while the first is still on its way", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.setFavoriteAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(list([job(1)]));
    await user.click(screen.getByRole("button", { name: "Favorite: Job 1" }));
    await user.click(screen.getByRole("button", { name: "Remove from favorites: Job 1" }));
    expect(mocks.setFavoriteAction).toHaveBeenCalledTimes(1);
    finish({ ok: true, favorite: true, changed: true, removed: null });
  });
});

describe("JobList: keys typed in a multi-select", () => {
  it("j / k / x do nothing while the focus is inside a multi-select popover or unfolded list", async () => {
    const user = userEvent.setup();
    render(
      <>
        <div data-slot="multi-select">
          <button type="button" data-testid="in-multi">
            pick
          </button>
        </div>
        {list([job(1), job(2)])}
      </>,
    );
    screen.getByTestId("in-multi").focus();
    await user.keyboard("jx");
    expect(mocks.setApplicationStatusAction).not.toHaveBeenCalled();
    expect(focusedJob()).toBeNull();
    // outside it the same keys work
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("j");
    expect(focusedJob()).toBe("1");
  });
});

describe("JobList: sortable column heads", () => {
  const hrefs = { score: "/jobs?sort=rank-link", salary: "/jobs?sort=salary", fresh: "/jobs?sort=first_seen" };
  const sorted = (sortHead?: { sort: "rank" | "salary" | "first_seen" | "posted"; dir: "asc" | "desc" }) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <JobList jobs={[job(1)]} label="Jobs" empty="none" viz={viz} {...(sortHead ? { sortHead: { ...sortHead, hrefs } } : {})} />
    </NextIntlClientProvider>
  );

  it("without sortHead the head stays plain, hidden text (Today, favorites)", () => {
    render(sorted());
    expect(screen.queryByTestId("sort-head-salary")).toBeNull();
    expect(document.querySelector("[data-slot=list-head]")).toHaveAttribute("aria-hidden");
    expect(screen.queryByTestId("sort-status")).toBeNull();
  });

  it("makes score, salary and freshness links that say their state; the others stay text", () => {
    render(sorted({ sort: "salary", dir: "desc" }));
    const head = document.querySelector("[data-slot=list-head]");
    expect(head).not.toHaveAttribute("aria-hidden");
    expect(head).toHaveAttribute("role", "group");
    const salary = screen.getByTestId("sort-head-salary");
    expect(salary).toHaveAttribute("href", "/jobs?sort=salary");
    expect(salary).toHaveAttribute("data-sort-active", "true");
    expect(salary).toHaveAttribute("data-sort-dir", "desc");
    expect(salary).toHaveAccessibleName("Salary / yr, sorted descending, click to sort ascending");
    const score = screen.getByTestId("sort-head-score");
    expect(score).toHaveAttribute("data-sort-active", "false");
    expect(score).not.toHaveAttribute("data-sort-dir");
    expect(score).toHaveAccessibleName("Rank value, click to sort descending");
    expect(screen.queryByTestId("sort-head-skills")).toBeNull();
    expect(screen.getByTestId("sort-status")).toHaveTextContent("Sorted by Salary / yr, descending");
  });

  it("names the drop-down's sort in the status when it has no column (publication time)", () => {
    render(sorted({ sort: "posted", dir: "asc" }));
    expect(screen.getByTestId("sort-status")).toHaveTextContent("Sorted by Posted, ascending");
    expect(document.querySelectorAll('[data-sort-active="true"]')).toHaveLength(0);
  });

  it("is reachable with Tab", async () => {
    const user = userEvent.setup();
    render(sorted({ sort: "rank", dir: "asc" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("sort-head-score"));
    expect(screen.getByTestId("sort-head-score")).toHaveAccessibleName("Rank value, sorted ascending, click to sort descending");
  });
});

describe("JobList: seen state", () => {
  it("acting on an unseen row marks it seen at once", async () => {
    const user = userEvent.setup();
    render(list([job(1, { seen: false }), job(2, { seen: false })]));
    await user.click(document.querySelector('[data-job-id="1"] [data-testid="row-favorite"]') as HTMLElement);
    await waitFor(() => expect(mocks.markSeenAction).toHaveBeenCalledWith({ jobId: 1, via: "action" }));
    expect(document.querySelector('[data-job-id="1"]')).toHaveAttribute("data-seen", "true");
    expect(document.querySelector('[data-job-id="2"]')).toHaveAttribute("data-seen", "false");
  });

  it("a seen row's action writes nothing more", async () => {
    const user = userEvent.setup();
    render(list([job(1, { seen: true })]));
    await user.click(document.querySelector('[data-job-id="1"] [data-testid="row-favorite"]') as HTMLElement);
    await waitFor(() => expect(mocks.setFavoriteAction).toHaveBeenCalled());
    expect(mocks.markSeenAction).not.toHaveBeenCalled();
  });

  it("u toggles the focused row between seen and unseen", async () => {
    const user = userEvent.setup();
    render(list([job(1, { seen: true }), job(2)]));
    (document.querySelector('[data-job-id="1"]') as HTMLElement).focus();
    await user.keyboard("u");
    await waitFor(() => expect(mocks.markUnseenAction).toHaveBeenCalledWith({ jobId: 1 }));
    expect(document.querySelector('[data-job-id="1"]')).toHaveAttribute("data-seen", "false");
    await user.keyboard("u");
    await waitFor(() => expect(mocks.markSeenAction).toHaveBeenCalledWith({ jobId: 1, via: "action" }));
    expect(document.querySelector('[data-job-id="1"]')).toHaveAttribute("data-seen", "true");
  });

  it("puts the old state back with an error when saving fails", async () => {
    mocks.markUnseenAction.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(list([job(1, { seen: true })]));
    (document.querySelector('[data-job-id="1"]') as HTMLElement).focus();
    await user.keyboard("u");
    await waitFor(() => expect(mocks.toastTone).toHaveBeenCalledWith("error", "Could not save, please retry"));
    expect(document.querySelector('[data-job-id="1"]')).toHaveAttribute("data-seen", "true");
  });

  it("shows on 'back' what this tab saw on the detail page, before the server says so", () => {
    window.sessionStorage.setItem("jr:seen-local", JSON.stringify({ "1": { seen: true, at: Date.now() } }));
    render(list([job(1, { seen: false }), job(2, { seen: false })]));
    expect(document.querySelector('[data-job-id="1"]')).toHaveAttribute("data-seen", "true");
    expect(document.querySelector('[data-job-id="2"]')).toHaveAttribute("data-seen", "false");
  });

  it("draws the 'new since your last visit' divider under the given row only", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <JobList jobs={[job(1, { isNew: true }), job(2, { isNew: true }), job(3)]} label="Jobs" empty="none" viz={viz} newDivider={{ afterJobId: 2, count: 2 }} />
      </NextIntlClientProvider>,
    );
    const divider = screen.getByRole("separator", { name: "Above: 2 new since your last visit" });
    expect(divider.closest("li")?.querySelector("[data-job-id]")).toHaveAttribute("data-job-id", "2");
    expect(screen.getAllByTestId("new-since-divider")).toHaveLength(1);
  });
});

describe("JobList: closing a job", () => {
  it("the fourth row button closes the job, moves the focus to the neighbour and offers an undo that puts the judgement back", async () => {
    const user = userEvent.setup();
    render(list([job(1), job(2), job(3)]));
    await user.click(screen.getByRole("button", { name: "Mark Job 2 as closed" }));
    await waitFor(() => expect(mocks.closeJobAction).toHaveBeenCalledWith({ jobId: 2 }));
    await waitFor(() => expect(mocks.toastUndo).toHaveBeenCalled());
    const [message, onUndo] = mocks.toastUndo.mock.calls[0] as [string, () => Promise<void>];
    expect(message).toBe("Marked as closed: Job 2");
    await onUndo();
    expect(mocks.undoClosureAction).toHaveBeenCalledWith({ jobId: 2, previous: null });
  });

  it("c reopens a job closed by the user or taken down at the source", async () => {
    const user = userEvent.setup();
    render(list([job(1, { jobStatus: "closed", closedReason: "manual" }), job(2)]));
    const button = screen.getByRole("button", { name: "Reopen Job 1" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("j");
    await user.keyboard("c");
    await waitFor(() => expect(mocks.reopenJobAction).toHaveBeenCalledWith({ jobId: 1 }));
    await waitFor(() => expect(mocks.toastUndo).toHaveBeenCalledWith("Reopened: Job 1", expect.any(Function), expect.anything()));
  });

  it("shows why a job is closed on its tag, with the evidence as its title", () => {
    render(
      list([
        job(1, { jobStatus: "possibly_closed", closedReason: "phrase", closedEvidence: { httpStatus: 200, quote: "no longer accepting applications", url: "https://jobs.example/1", at: "2026-10-09T08:00:00.000Z" } }),
        job(2, { jobStatus: "closed", closedReason: "gone", closedEvidence: null }),
      ]),
    );
    const chips = document.querySelectorAll('[data-slot="job-status-chip"]');
    expect([...chips].map((c) => c.getAttribute("data-reason"))).toEqual(["phrase", "gone"]);
    expect(chips[0]).toHaveTextContent("Source says no longer accepting");
    expect(chips[0]?.getAttribute("title")).toContain("no longer accepting applications");
    expect(chips[1]).toHaveTextContent("Taken down at the source");
  });

  it("puts nothing back and says so when saving fails", async () => {
    mocks.closeJobAction.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(list([job(1)]));
    await user.click(screen.getByRole("button", { name: "Mark Job 1 as closed" }));
    await waitFor(() => expect(mocks.toastTone).toHaveBeenCalledWith("error", "Could not save, please retry"));
    expect(mocks.toastUndo).not.toHaveBeenCalled();
  });
});
