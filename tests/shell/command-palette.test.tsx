import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NAV_ITEMS, PALETTE_SUBPAGES } from "@/components/shell/nav";
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
    render(wrap(<CommandPalette minChars={2} />));
    const trigger = screen.getByRole("button", { name: /^跳转/ });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    expect(within(dialog).getAllByRole("option")).toHaveLength(NAV_ITEMS.length + PALETTE_SUBPAGES.length);
    expect(within(dialog).getByRole("option", { name: /公司/ })).toBeInTheDocument();
    expect(within(dialog).getByTestId("palette-page-registry")).toHaveTextContent("来源清单");
    expect(within(dialog).getByTestId("palette-page-aiUsage")).toHaveTextContent("AI 用量");
    expect(within(dialog).getByTestId("activity-log-palette")).toHaveTextContent("操作日志");
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

  it("finds activity logs by English and Chinese keywords", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jobs: [] })));
    const user = userEvent.setup();
    render(wrap(<CommandPalette minChars={2} />));
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    for (const keyword of ["logs", "日志"]) {
      await user.clear(input);
      await user.type(input, keyword);
      expect(within(dialog).getByTestId("activity-log-palette")).toBeVisible();
    }
  });

  it("opens with Ctrl+K and navigates on Enter", async () => {
    const user = userEvent.setup();
    render(wrap(<CommandPalette minChars={2} />));
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "命令面板" });
    await user.keyboard("统计{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/insights");
  });

  it("gives the focus to the search button when it was opened with Ctrl+K from nowhere", async () => {
    const user = userEvent.setup();
    render(wrap(<CommandPalette minChars={2} />));
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "命令面板" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /^跳转/ })).toHaveFocus();
  });

  it("renders no dialog title (an h2 before the page heading) while closed", () => {
    render(wrap(<CommandPalette minChars={2} />));
    expect(screen.queryByRole("heading", { name: "命令面板" })).toBeNull();
  });
});

it("uses the server minimum, preserves response order and opens all results with the encoded query", async () => {
  const fetcher = vi.fn(async () => Response.json({ jobs: [
    { id: 9, title: "Result with highest relevance", company: "Example", location: null, rank: 10 },
    { id: 1, title: "Result with higher rank", company: "Example", location: null, rank: 99 },
  ] }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(wrap(<CommandPalette minChars={3} />));
  await user.click(screen.getByRole("button", { name: /^跳转/ }));
  expect(screen.queryByTestId("palette-jobs")).toBeNull();
  expect(screen.queryByTestId("palette-view-all")).toBeNull();
  const input = screen.getByRole("combobox");
  await user.type(input, "AI");
  expect(screen.queryByTestId("palette-view-all")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  await user.type(input, " &");
  await waitFor(() => expect(screen.getAllByTestId("palette-job")).toHaveLength(2));
  expect(screen.getAllByTestId("palette-job").map((row) => row.textContent)).toEqual([
    expect.stringContaining("highest relevance"), expect.stringContaining("higher rank"),
  ]);
  await user.click(screen.getByTestId("palette-view-all"));
  expect(mocks.push).toHaveBeenLastCalledWith("/jobs?q=AI%20%26");
});

it("selects the first job once results arrive, so Enter opens it rather than all results", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => {
    await gate;
    return Response.json({ jobs: [
      { id: 42, title: "Quantum Firmware Engineer", company: "Example", location: null, rank: 70 },
      { id: 43, title: "Quantum Firmware Lead", company: "Example", location: null, rank: 60 },
    ] });
  }));
  const user = userEvent.setup();
  render(wrap(<CommandPalette minChars={2} />));
  await user.click(screen.getByRole("button", { name: /^跳转/ }));
  await user.type(screen.getByRole("combobox"), "quantum firmware");
  // while the request is pending there is nothing to select yet, not even "view all"
  expect(screen.queryByTestId("palette-view-all")).toBeNull();
  release();
  await waitFor(() => expect(screen.getAllByTestId("palette-job")).toHaveLength(2));
  expect(screen.getByTestId("palette-view-all")).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByTestId("palette-job")[0]).toHaveAttribute("aria-selected", "true"));
  await user.keyboard("{Enter}");
  expect(mocks.push).toHaveBeenLastCalledWith("/jobs/42");
});
