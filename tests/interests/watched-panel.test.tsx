import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/interests/actions", () => ({ addWatchedCompanyAction: vi.fn(), removeWatchedCompanyAction: vi.fn(), suggestCompaniesAction: vi.fn(async () => []) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WatchedPanel } from "@/components/interests/watched-panel";
import type { WatchedCompanyView } from "@/lib/interests/types";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const watched: WatchedCompanyView[] = [
  { name: "Anthropic", match: null, hasBoard: true },
  { name: "Google", match: { name: "Google", jobCount: 3 }, hasBoard: false, companyQueryChannels: 3 },
];

describe("WatchedPanel: companies without a job board", () => {
  it("shows enabled company-query capacity only for companies without a board, with a link to the registry", () => {
    render(wrap(<WatchedPanel watched={watched} />));
    const [anthropic, google] = screen.getAllByTestId("watched-item");
    expect(within(anthropic as HTMLElement).queryByTestId("watched-no-board")).toBeNull();
    const hint = within(google as HTMLElement).getByTestId("watched-no-board");
    expect(hint).toHaveTextContent("Will search by company name on 3 enabled channels.");
    expect(within(hint).getByRole("link", { name: "Add a board" })).toHaveAttribute("href", "/sources/registry");
  });

  it("says it in Chinese", () => {
    render(wrap(<WatchedPanel watched={watched} />, "zh"));
    expect(screen.getByTestId("watched-no-board")).toHaveTextContent("将按公司名在 3 个已启用通道上查询。");
    expect(screen.getByRole("link", { name: "添加看板" })).toHaveAttribute("href", "/sources/registry");
  });

  it("falls back to the board hint when no channel searches by company name (master switch off or none enabled)", () => {
    const none: WatchedCompanyView[] = [{ name: "Google", match: null, hasBoard: false, companyQueryChannels: 0 }];
    render(wrap(<WatchedPanel watched={none} />));
    const hint = screen.getByTestId("watched-no-board");
    expect(hint).toHaveTextContent("No job board configured: its jobs are only found through the queries for your target cities.");
    expect(hint).not.toHaveTextContent("Will search by company name");
    expect(within(hint).getByRole("link", { name: "Add a board" })).toHaveAttribute("href", "/sources/registry");
  });

  it("falls back to the board hint in Chinese too", () => {
    render(wrap(<WatchedPanel watched={[{ name: "Google", match: null, hasBoard: false }]} />, "zh"));
    expect(screen.getByTestId("watched-no-board")).toHaveTextContent("没有配置招聘看板：只能靠目标城市的查询采到。");
  });

  it("uses the singular for one enabled channel", () => {
    render(wrap(<WatchedPanel watched={[{ name: "Google", match: null, hasBoard: false, companyQueryChannels: 1 }]} />));
    expect(screen.getByTestId("watched-no-board")).toHaveTextContent("Will search by company name on 1 enabled channel.");
  });

  it("shows nothing for an empty list", () => {
    render(wrap(<WatchedPanel watched={[]} />));
    expect(screen.queryByTestId("watched-no-board")).toBeNull();
  });
});
