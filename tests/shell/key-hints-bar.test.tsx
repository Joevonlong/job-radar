import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { KeyHints } from "@/components/jobs/key-hints";
import { KeyHintsBar } from "@/components/shell/key-hints-bar";

import zh from "../../messages/zh.json";

describe("KeyHintsBar", () => {
  it("shows each key cap followed by what it does", () => {
    render(<KeyHintsBar label="快捷键" hints={[{ keys: ["j", "k"], label: "上下" }, { keys: ["Enter"], label: "打开" }]} />);
    const bar = screen.getByRole("group", { name: "快捷键" });
    expect(bar).toHaveTextContent("jk上下Enter打开");
    expect(bar.querySelectorAll("kbd")).toHaveLength(3);
  });

  it("is desktop only (hidden below md)", () => {
    render(<KeyHintsBar label="x" hints={[]} />);
    expect(screen.getByRole("group", { hidden: true })).toHaveClass("hidden", "md:flex");
  });
});

describe("KeyHints", () => {
  it("keeps the list shortcuts: j k, Enter, s, x, f, u, c and the palette", () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <KeyHints />
      </NextIntlClientProvider>,
    );
    const bar = screen.getByLabelText("键盘快捷键");
    expect([...bar.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["j", "k", "Enter", "s", "x", "f", "u", "c", "Ctrl", "K"]);
    expect(bar).toHaveTextContent("已看 / 未看");
    expect(bar).toHaveTextContent("关闭 / 重新打开");
    expect(bar).toHaveTextContent("命令面板");
  });
});
