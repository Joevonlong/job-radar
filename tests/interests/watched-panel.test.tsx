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
  { name: "Google", match: { name: "Google", jobCount: 3 }, hasBoard: false },
];

describe("WatchedPanel: companies without a job board", () => {
  it("tells only the company without a board that its jobs come from the city queries, with a link to the registry", () => {
    render(wrap(<WatchedPanel watched={watched} />));
    const [anthropic, google] = screen.getAllByTestId("watched-item");
    expect(within(anthropic as HTMLElement).queryByTestId("watched-no-board")).toBeNull();
    const hint = within(google as HTMLElement).getByTestId("watched-no-board");
    expect(hint).toHaveTextContent("No job board configured: its jobs are only found through the queries for your target cities.");
    expect(within(hint).getByRole("link", { name: "Add a board" })).toHaveAttribute("href", "/sources/registry");
  });

  it("says it in Chinese", () => {
    render(wrap(<WatchedPanel watched={watched} />, "zh"));
    expect(screen.getByTestId("watched-no-board")).toHaveTextContent("没有配置招聘看板：只能靠目标城市的查询采到。");
    expect(screen.getByRole("link", { name: "添加看板" })).toHaveAttribute("href", "/sources/registry");
  });

  it("shows nothing for an empty list", () => {
    render(wrap(<WatchedPanel watched={[]} />));
    expect(screen.queryByTestId("watched-no-board")).toBeNull();
  });
});
