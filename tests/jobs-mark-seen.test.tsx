import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkSeenButton } from "@/components/jobs/mark-seen-button";
import { VisitTracker } from "@/components/jobs/visit-tracker";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const mocks = vi.hoisted(() => ({
  markAllSeenAction: vi.fn(),
  undoMarkAllSeenAction: vi.fn(),
  recordVisitAction: vi.fn(),
  refresh: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/app/visit-actions", () => ({ markAllSeenAction: mocks.markAllSeenAction, undoMarkAllSeenAction: mocks.undoMarkAllSeenAction, recordVisitAction: mocks.recordVisitAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const wrap = (node: React.ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const AT = "2026-10-10T08:00:00.000Z";
const JOBS = { scope: "jobs", query: "sort=salary&unseen=true", renderedAt: "2026-10-10T10:00:00.000Z" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markAllSeenAction.mockResolvedValue({ ok: true, count: 5, at: AT });
  mocks.undoMarkAllSeenAction.mockResolvedValue({ ok: true });
});

describe("MarkSeenButton", () => {
  it("shows how many jobs are unseen and nothing when none is", () => {
    const { container, rerender } = render(wrap(<MarkSeenButton count={32} target={JOBS} />));
    expect(screen.getByTestId("unseen-count")).toHaveTextContent("32 unseen");
    expect(screen.getByTestId("unseen-count")).toHaveAttribute("data-count", "32");
    expect(screen.getByTestId("mark-all-seen")).toHaveTextContent("Mark all as seen");
    rerender(wrap(<MarkSeenButton count={0} target={JOBS} />));
    expect(container.textContent).toBe("");
  });

  it("speaks Chinese", () => {
    render(wrap(<MarkSeenButton count={3} target={{ scope: "list", jobIds: [1, 2, 3] }} />, "zh"));
    expect(screen.getByTestId("unseen-count")).toHaveTextContent("3 条未看");
    expect(screen.getByTestId("mark-all-seen")).toHaveTextContent("全部标为已看");
  });

  it("marks the target seen, refreshes, and the toast's undo takes back exactly that batch", async () => {
    render(wrap(<MarkSeenButton count={5} target={JOBS} />));
    await userEvent.click(screen.getByTestId("mark-all-seen"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.markAllSeenAction).toHaveBeenCalledWith(JOBS);
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    const [message, config] = mocks.toast.success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toBe("Marked 5 jobs as seen");
    expect(config.action.label).toBe("Undo");
    config.action.onClick();
    await waitFor(() => expect(mocks.undoMarkAllSeenAction).toHaveBeenCalledWith({ at: AT }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("passes Today's job ids as they are", async () => {
    render(wrap(<MarkSeenButton count={2} target={{ scope: "list", jobIds: [7, 9] }} />));
    await userEvent.click(screen.getByTestId("mark-all-seen"));
    await waitFor(() => expect(mocks.markAllSeenAction).toHaveBeenCalledWith({ scope: "list", jobIds: [7, 9] }));
  });

  it("says so when saving failed, and does not refresh", async () => {
    mocks.markAllSeenAction.mockResolvedValue({ ok: false });
    render(wrap(<MarkSeenButton count={5} target={JOBS} />));
    await userEvent.click(screen.getByTestId("mark-all-seen"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Could not save, please retry", expect.anything()));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("VisitTracker", () => {
  it("records the visit once when the page opens and renders nothing", () => {
    const { container } = render(<VisitTracker />);
    expect(container.textContent).toBe("");
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);
  });
});
