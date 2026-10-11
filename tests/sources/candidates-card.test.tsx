import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CandidatesCard } from "@/components/sources/candidates-card";
import type { CandidateView } from "@/lib/sources/candidates";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const actions = vi.hoisted(() => ({ add: vi.fn(), dismiss: vi.fn() }));
vi.mock("@/app/sources/actions", () => ({ addBoardCandidateAction: actions.add, dismissBoardCandidateAction: actions.dismiss }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en", searchParams = "") => {
  const Adapter = withNuqsTestingAdapter({ searchParams });
  return (
    <Adapter>
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
        {node}
      </NextIntlClientProvider>
    </Adapter>
  );
};

const candidate = (extra: Partial<CandidateView> = {}): CandidateView => ({
  ats: "ashby",
  token: "acme-labs",
  region: null,
  name: "Acme Labs",
  boardUrl: "https://jobs.ashbyhq.com/acme-labs",
  title: "AI Engineer - Acme Labs",
  seenCount: 3,
  lastSeenAt: new Date("2026-10-06T10:00:00Z"),
  ...extra,
});

beforeEach(() => {
  actions.add.mockReset();
  actions.dismiss.mockReset();
});

describe("CandidatesCard", () => {
  it("lists a candidate with its ats, board link and sighting count", () => {
    render(wrap(<CandidatesCard candidates={[candidate(), candidate({ ats: "lever", token: "euco", name: "Euco", region: "eu", title: null })]} timeZone="Europe/Berlin" />));
    const rows = screen.getAllByTestId("candidate");
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("Acme Labs")).toBeInTheDocument();
    expect(first.getByText("ashby")).toBeInTheDocument();
    expect(first.getByText("AI Engineer - Acme Labs")).toBeInTheDocument();
    expect(first.getByRole("link", { name: /Open board/ })).toHaveAttribute("href", "https://jobs.ashbyhq.com/acme-labs");
    expect(first.getByText(/seen 3×/)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("EU host")).toBeInTheDocument();
  });

  it("shows an empty state, and an error when the list cannot be read", () => {
    const { rerender } = render(wrap(<CandidatesCard candidates={[]} timeZone="UTC" />));
    expect(screen.getByTestId("candidates-empty")).toHaveTextContent(/TAVILY_API_KEY/);
    rerender(wrap(<CandidatesCard candidates={null} timeZone="UTC" />));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("add sends the board to the server action and reports the outcome", async () => {
    const user = userEvent.setup();
    actions.add.mockResolvedValue({ status: "done", outcome: "added" });
    render(wrap(<CandidatesCard candidates={[candidate()]} timeZone="UTC" />));
    await user.click(screen.getByTestId("candidate-add"));
    expect(actions.add).toHaveBeenCalledWith({ ats: "ashby", token: "acme-labs" });
    await waitFor(() => expect(screen.getByTestId("candidate-feedback")).toHaveTextContent("Acme Labs added to the source registry (sources.yaml)."));
  });

  it("dismiss and a failed add show their messages (in Chinese too)", async () => {
    const user = userEvent.setup();
    actions.dismiss.mockResolvedValue({ status: "done", outcome: "dismissed" });
    actions.add.mockResolvedValue({ status: "error", error: "write_failed" });
    render(wrap(<CandidatesCard candidates={[candidate()]} timeZone="UTC" />, "zh"));
    await user.click(screen.getByTestId("candidate-add"));
    await waitFor(() => expect(screen.getByTestId("candidate-feedback")).toHaveTextContent("无法写入 sources.yaml。"));
    await user.click(screen.getByTestId("candidate-dismiss"));
    expect(actions.dismiss).toHaveBeenCalledWith({ ats: "ashby", token: "acme-labs" });
    await waitFor(() => expect(screen.getByTestId("candidate-feedback")).toHaveTextContent("已忽略 Acme Labs。"));
  });

  describe("a long list is capped and the registry filters apply", () => {
    const many = Array.from({ length: 25 }, (_, i) => candidate({ token: `board-${i}`, name: `Board ${i}`, ats: i % 2 === 0 ? "ashby" : "lever" }));

    it("lists one page with the total, and 'show more' adds the next page", async () => {
      const user = userEvent.setup();
      render(wrap(<CandidatesCard candidates={many} timeZone="UTC" pageSize={10} />));
      expect(screen.getAllByTestId("candidate")).toHaveLength(10);
      expect(screen.getByTestId("candidates-count")).toHaveTextContent("25 in total");
      await user.click(screen.getByTestId("candidates-more"));
      expect(screen.getAllByTestId("candidate")).toHaveLength(20);
      await user.click(screen.getByTestId("candidates-more"));
      expect(screen.getAllByTestId("candidate")).toHaveLength(25);
      expect(screen.queryByTestId("candidates-more")).toBeNull();
    });

    it("applies the search text and the ATS of the registry, and says so", () => {
      render(wrap(<CandidatesCard candidates={many} timeZone="UTC" pageSize={50} />, "en", "?q=board-1&ats=lever"));
      const tokens = screen.getAllByTestId("candidate").map((row) => row.getAttribute("data-token"));
      expect(tokens).toEqual(["board-1", "board-11", "board-13", "board-15", "board-17", "board-19"]);
      expect(screen.getByTestId("candidates-count")).toHaveTextContent("6 match the filters, 25 in total");
    });

    it("says that a status filter does not apply here, and shows an empty match as such", () => {
      render(wrap(<CandidatesCard candidates={many} timeZone="UTC" />, "en", "?status=failing"));
      expect(screen.getByTestId("candidates-count")).toHaveTextContent("the status filter does not apply here");
      expect(screen.getAllByTestId("candidate")).toHaveLength(10);
    });

    it("shows a no-match note", () => {
      render(wrap(<CandidatesCard candidates={many} timeZone="UTC" />, "zh", "?q=nothing-like-this"));
      expect(screen.getByTestId("candidates-no-match")).toHaveTextContent("没有符合筛选的 board。");
    });
  });
});
