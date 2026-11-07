import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/shell/app-shell";
import { CommandPalette } from "@/components/shell/command-palette";
import { CAREER_NAV_ITEM, NAV_ITEMS, PALETTE_SUBPAGES, navItems } from "@/components/shell/nav";
import { NavList } from "@/components/shell/nav-list";
import { ShellNavProvider } from "@/components/shell/shell-nav-provider";

import zh from "../../messages/zh.json";

const mocks = vi.hoisted(() => ({ gate: vi.fn(async () => ({ enabled: true })) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/career", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/config/career-gate", () => ({ readCareerGate: mocks.gate }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/shell/status", () => ({ loadShellStatus: async () => null }));
vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jobs: [] })));

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="zh" messages={zh}>
    {node}
  </NextIntlClientProvider>
);

function findProvider(node: ReactNode): ReactElement<{ career: boolean }> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === ShellNavProvider) return node as ReactElement<{ career: boolean }>;
  const children = ([] as ReactNode[]).concat(node.props.children ?? []);
  return children.map(findProvider).find(Boolean);
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => mocks.gate.mockClear());

describe("career nav item", () => {
  it("leaves the default navigation unchanged while the career feature is off", () => {
    expect(navItems(false)).toBe(NAV_ITEMS);
  });

  it("puts the career profile right after the pipeline while it is on", () => {
    expect(navItems(true).map((item) => item.href)).toEqual([
      "/", "/jobs", "/companies", "/favorites", "/pipeline", "/career", "/sources", "/insights", "/settings", "/me", "/interests",
    ]);
    expect(CAREER_NAV_ITEM.group).toBe("main");
    expect(zh.nav.career).toBe("职业档案");
    expect(zh.pages.career.title).toBeTruthy();
  });

  it("shows the item in the sidebar list only inside an enabled provider", () => {
    const { rerender } = render(wrap(<ShellNavProvider career={false}><NavList counts={{}} /></ShellNavProvider>));
    expect(screen.queryByRole("link", { name: "职业档案" })).toBeNull();
    rerender(wrap(<ShellNavProvider career><NavList counts={{}} /></ShellNavProvider>));
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.slice(4, 6)).toEqual(["申请", "职业档案"]);
    expect(screen.getByRole("link", { name: "职业档案" })).toHaveAttribute("aria-current", "page");
  });

  it("lists the item in the command palette while it is on", async () => {
    const user = userEvent.setup();
    render(wrap(<ShellNavProvider career><CommandPalette minChars={2} /></ShellNavProvider>));
    await user.click(screen.getByRole("button", { name: /^跳转/ }));
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    expect(within(dialog).getAllByRole("option")).toHaveLength(NAV_ITEMS.length + 1 + PALETTE_SUBPAGES.length);
    expect(within(dialog).getByRole("option", { name: /职业档案/ })).toBeInTheDocument();
  });

  it("reads the switch in the signed-in shell and never in the locked one", async () => {
    const open = await AppShell({ children: null, access: { locked: false, banner: false, signOut: false } });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(findProvider(open)?.props.career).toBe(true);
    mocks.gate.mockClear();
    const locked = await AppShell({ children: null, access: { locked: true, banner: false, signOut: false } });
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(findProvider(locked)).toBeUndefined();
  });
});
