import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { NavList } from "@/components/shell/nav-list";
import { ShellStatusProvider } from "@/components/shell/shell-status-provider";

import zh from "../../messages/zh.json";

const mocks = vi.hoisted(() => ({ pathname: "/jobs/12" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
// the provider polls the status; the test hands it a status and never answers a fetch
vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="zh" messages={zh}>
    {node}
  </NextIntlClientProvider>
);

describe("NavList", () => {
  it("lists the 10 pages in order, the last three in a labelled settings group", () => {
    render(wrap(<NavList />));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["今日", "岗位", "公司", "收藏", "申请", "来源", "统计", "设置", "我的画像", "感兴趣清单"]);
    const group = within(nav).getByRole("group", { name: "// 设置" });
    expect(within(group).getAllByRole("link").map((l) => l.textContent)).toEqual(["设置", "我的画像", "感兴趣清单"]);
  });

  it("marks only the current page, also for its sub-routes", () => {
    render(wrap(<NavList />));
    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual(["岗位"]);
    expect(current[0]).toHaveClass("bg-term-amber");
  });

  it("shows count badges only for keys that have a count", () => {
    render(wrap(<NavList counts={{ jobs: 135, pipeline: 0 }} />));
    expect(screen.getByTestId("nav-count-jobs")).toHaveTextContent("135");
    expect(screen.getByTestId("nav-count-pipeline")).toHaveTextContent("0");
    expect(screen.queryByTestId("nav-count-today")).toBeNull();
  });

  it("shows a warning badge for the sources that need a look, and nothing for 0", () => {
    const { rerender } = render(wrap(<NavList counts={{}} alerts={{ sources: 2 }} />));
    expect(screen.getByTestId("nav-alert-sources")).toHaveTextContent("2");
    expect(screen.getByTestId("nav-alert-sources")).toHaveAttribute("aria-label", "来源页有 2 项需要处理");
    rerender(wrap(<NavList counts={{}} alerts={{ sources: 0 }} />));
    expect(screen.queryByTestId("nav-alert-sources")).toBeNull();
  });

  it("takes its badges from the shared shell status when no props are given", () => {
    const status = {
      now: "2026-10-08T03:00:00.000Z", state: "idle" as const, timezone: "Europe/Berlin", next: null, cycle: null, sources: null, progress: null,
      runner: { online: true, ageSeconds: 5 }, aiWorker: { expected: false, online: false, ageSeconds: null },
      counts: { today: 0, jobs: 135, pipeline: 6, favorites: 3, sourcesAlert: 1 },
    };
    render(wrap(<ShellStatusProvider initial={status}><NavList /></ShellStatusProvider>));
    expect(screen.getByTestId("nav-count-jobs")).toHaveTextContent("135");
    expect(screen.getByTestId("nav-count-pipeline")).toHaveTextContent("6");
    expect(screen.getByTestId("nav-count-favorites")).toHaveTextContent("3");
    // nothing new today: no badge on Today
    expect(screen.queryByTestId("nav-count-today")).toBeNull();
    expect(screen.getByTestId("nav-alert-sources")).toHaveTextContent("1");
  });
});
