import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SaveBar } from "@/components/settings/save-bar";
import { leavingHref, UnsavedGuard } from "@/components/shell/unsaved-guard";
import { hasUnsaved, registerUnsaved, requestLeave } from "@/lib/shell/unsaved";

import zh from "../../messages/zh.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="zh" messages={zh}>
    {node}
  </NextIntlClientProvider>
);

const labels = { dirty: (count: number) => `${count} 处未保存`, clean: "没有改动", save: "保存", saving: "保存中", revert: "还原" };

afterEach(() => {
  push.mockReset();
});

describe("SaveBar", () => {
  it("docks to the bottom of the viewport in its own sticky wrapper only while there are unsaved changes, and turns Save off while clean", () => {
    const { rerender } = render(wrap(<SaveBar floating labels={labels} dirtyCount={0} pending={false} onRevert={() => {}} />));
    // clean: it only sits in the flow (a floating clean bar just covers content)
    expect(screen.getByTestId("save-bar-dock")).not.toHaveClass("sticky");
    expect(screen.getByTestId("save-bar-dock")).toHaveAttribute("data-floating", "false");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(hasUnsaved()).toBe(false);
    rerender(wrap(<SaveBar floating labels={labels} dirtyCount={2} pending={false} onRevert={() => {}} />));
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(hasUnsaved()).toBe(true);
    expect(screen.getByTestId("save-bar-dock")).toHaveClass("sticky");
  });

  it("with two dirty forms only the one edited last floats (never two bars piled at the bottom edge)", () => {
    const bar = (label: string, count: number) => <SaveBar floating labels={{ ...labels, save: label }} dirtyCount={count} pending={false} onRevert={() => {}} />;
    const { rerender } = render(wrap(<>{bar("保存A", 0)}{bar("保存B", 0)}</>));
    rerender(wrap(<>{bar("保存A", 1)}{bar("保存B", 0)}</>));
    rerender(wrap(<>{bar("保存A", 1)}{bar("保存B", 1)}</>));
    const docks = screen.getAllByTestId("save-bar-dock");
    expect(docks.map((dock) => dock.getAttribute("data-floating"))).toEqual(["false", "true"]);
    // B is saved: A is the only dirty one left and takes over
    rerender(wrap(<>{bar("保存A", 1)}{bar("保存B", 0)}</>));
    expect(screen.getAllByTestId("save-bar-dock").map((dock) => dock.getAttribute("data-floating"))).toEqual(["true", "false"]);
  });

  it("stops telling the guard once the form is clean again or gone", () => {
    const { rerender, unmount } = render(wrap(<SaveBar labels={labels} dirtyCount={1} pending={false} onRevert={() => {}} />));
    expect(hasUnsaved()).toBe(true);
    rerender(wrap(<SaveBar labels={labels} dirtyCount={0} pending={false} onRevert={() => {}} />));
    expect(hasUnsaved()).toBe(false);
    rerender(wrap(<SaveBar labels={labels} dirtyCount={1} pending={false} onRevert={() => {}} />));
    unmount();
    expect(hasUnsaved()).toBe(false);
  });
});

describe("UnsavedGuard", () => {
  it("lets a link through when nothing is unsaved", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn((event: React.MouseEvent) => event.preventDefault());
    render(wrap(<><UnsavedGuard /><a href="/elsewhere" onClick={onClick}>jobs</a></>));
    await user.click(screen.getByText("jobs"));
    expect(onClick).toHaveBeenCalled();
    expect(screen.queryByTestId("unsaved-dialog")).toBeNull();
  });

  it("holds a link click while edits are unsaved: Stay keeps the page, Discard follows the link", async () => {
    const user = userEvent.setup();
    const clicked = vi.fn((event: React.MouseEvent) => event.preventDefault());
    const release = registerUnsaved("test-form");
    render(wrap(<><UnsavedGuard /><a href="/me" onClick={clicked}>me</a></>));

    await user.click(screen.getByText("me"));
    expect(clicked).not.toHaveBeenCalled();
    expect(screen.getByTestId("unsaved-dialog")).toHaveTextContent("有改动还没保存");

    await user.click(screen.getByTestId("unsaved-stay"));
    expect(screen.queryByTestId("unsaved-dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByText("me"));
    await user.click(screen.getByTestId("unsaved-discard"));
    expect(push).toHaveBeenCalledWith("/me");
    release();
  });

  it("the command palette asks through requestLeave", async () => {
    const release = registerUnsaved("palette");
    render(wrap(<UnsavedGuard />));
    expect(requestLeave("/insights")).toBe(false);
    expect(await screen.findByTestId("unsaved-dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("unsaved-discard"));
    expect(push).toHaveBeenCalledWith("/insights");
    release();
    expect(requestLeave("/x")).toBe(true);
  });

  it("only a plain left click on an in-app link to another page counts as leaving", () => {
    const at = { href: "http://localhost:3000/settings", origin: "http://localhost:3000", pathname: "/settings" } as Location;
    const click = (html: string, init: MouseEventInit = {}): MouseEvent | null => {
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.append(host);
      const anchor = host.querySelector("a") as HTMLAnchorElement;
      let seen: MouseEvent | null = null;
      anchor.addEventListener("click", (event) => (seen = event));
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
      host.remove();
      return seen;
    };
    const href = (html: string, init?: MouseEventInit) => {
      const event = click(html, init);
      return event ? leavingHref(event, at) : "none";
    };
    expect(href('<a href="/me?tab=x">x</a>')).toBe("/me?tab=x");
    expect(href('<a href="/settings?tab=ai">same page</a>')).toBeNull();
    expect(href('<a href="https://example.com/">out</a>')).toBeNull();
    expect(href('<a href="/me" target="_blank">new tab</a>')).toBeNull();
    expect(href('<a href="/me">ctrl</a>', { ctrlKey: true })).toBeNull();
  });
});
