import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CommandPalette, PaletteScore } from "@/components/shell/command-palette";

import zh from "../../messages/zh.json";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="zh" messages={zh}>
    {node}
  </NextIntlClientProvider>
);

beforeAll(() => {
  // cmdk needs these in jsdom
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => vi.unstubAllGlobals());

describe("PaletteScore", () => {
  it("shows 88/100 with a bar", () => {
    render(<PaletteScore rank={88} label="排序值 88 / 100" />);
    expect(screen.getByTestId("palette-score")).toHaveTextContent("88/100");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "88");
  });

  it("keeps a rank above 100 whole, marks the overflow and stops the bar at full", () => {
    render(<PaletteScore rank={106} label="排序值 106" />);
    expect(screen.getByTestId("palette-score")).toHaveTextContent("106/100+6");
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "106");
    expect(meter).toHaveAttribute("aria-valuemax", "106");
  });

  it("shows a dash, no bar and never 0 when the job is not scored", () => {
    render(<PaletteScore rank={null} label="未评分" />);
    expect(screen.getByTestId("palette-score")).toHaveTextContent("—");
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("CommandPalette", () => {
  it("opens from the button, lists pages, job results with scores, and Esc gives the focus back to the button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ jobs: [{ id: 5, title: "Forward Deployed Engineer", company: "Kobalt", location: "Berlin", rank: 81 }, { id: 6, title: "Forward Analyst", company: "Acme", location: null, rank: null }] })),
    );
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));
    const trigger = screen.getByRole("button", { name: /^搜索/ });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    expect(within(dialog).getAllByRole("option")).toHaveLength(12);
    expect(within(dialog).getByRole("option", { name: /公司/ })).toBeInTheDocument();
    expect(within(dialog).getByTestId("palette-page-registry")).toHaveTextContent("来源清单");
    expect(within(dialog).getByTestId("palette-page-aiUsage")).toHaveTextContent("AI 用量");
    // the footer lists the real keys
    expect(within(dialog).getByRole("group", { name: "面板快捷键" })).toHaveTextContent("Esc关闭");

    await user.type(within(dialog).getByRole("combobox"), "forward");
    await waitFor(() => expect(within(dialog).getByText("Forward Deployed Engineer")).toBeInTheDocument());
    const scores = within(dialog).getAllByTestId("palette-score").map((s) => s.textContent);
    expect(scores).toContain("81/100");
    expect(scores).toContain("—");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("opens with Ctrl+K and navigates on Enter", async () => {
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "命令面板" });
    await user.keyboard("统计{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/insights");
  });

  it("gives the focus to the search button when it was opened with Ctrl+K from nowhere", async () => {
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "命令面板" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /^搜索/ })).toHaveFocus();
  });

  it("renders no dialog title (an h2 before the page heading) while closed", () => {
    render(wrap(<CommandPalette />));
    expect(screen.queryByRole("heading", { name: "命令面板" })).toBeNull();
  });
});
