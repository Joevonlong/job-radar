import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/sonner";
import { setToastUndoLabel, toastTone, toastUndo, TOAST_LIFE_MS } from "@/lib/toast";

import zh from "../../messages/zh.json";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  icons: undefined as Record<string, React.ReactNode> | undefined,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, info: mocks.info, warning: mocks.warning, error: mocks.error },
  Toaster: (props: { icons?: Record<string, React.ReactNode> }) => {
    mocks.icons = props.icons;
    return null;
  },
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light" }) }));

beforeEach(() => vi.clearAllMocks());

describe("toastTone", () => {
  it.each([
    ["success", "success"],
    ["info", "info"],
    ["warn", "warning"],
    ["error", "error"],
  ] as const)("%s uses sonner's %s with the token life", (tone, method) => {
    toastTone(tone, "hello");
    expect(mocks[method]).toHaveBeenCalledTimes(1);
    const [message, config] = mocks[method].mock.calls[0] as [string, { duration: number; style: Record<string, string> }];
    expect(message).toBe("hello");
    expect(config.duration).toBe(TOAST_LIFE_MS);
    expect(config.style["--toast-life"]).toBe(`${TOAST_LIFE_MS}ms`);
  });

  it("lets the caller pick the life, which also sets the countdown bar", () => {
    toastTone("info", "x", { duration: 8000, id: "same" });
    const config = mocks.info.mock.calls[0]?.[1] as { id: string; duration: number; style: Record<string, string> };
    expect(config).toMatchObject({ id: "same", duration: 8000 });
    expect(config.style["--toast-life"]).toBe("8000ms");
  });
});

describe("toastUndo", () => {
  it("adds an undo action that runs the callback", () => {
    const onUndo = vi.fn();
    setToastUndoLabel("撤销");
    toastUndo("已忽略", onUndo);
    const config = mocks.success.mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } };
    expect(config.action.label).toBe("撤销");
    expect(onUndo).not.toHaveBeenCalled();
    config.action.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("can use another tone and label", () => {
    toastUndo("deleted", vi.fn(), { tone: "warn", label: "Put back" });
    const config = mocks.warning.mock.calls[0]?.[1] as { action: { label: string } };
    expect(config.action.label).toBe("Put back");
  });
});

describe("Toaster", () => {
  it("gives every tone a glyph and a spoken tone name, and sets the translated undo label", () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Toaster />
      </NextIntlClientProvider>,
    );
    const glyphs = { success: "✓", info: "i", warning: "!", error: "✕" } as const;
    const names = { success: "成功", info: "信息", warning: "提醒", error: "错误" } as const;
    for (const tone of Object.keys(glyphs) as (keyof typeof glyphs)[]) {
      const { container } = render(<>{mocks.icons?.[tone]}</>);
      expect(container).toHaveTextContent(glyphs[tone]);
      expect(container).toHaveTextContent(names[tone]);
    }
    toastUndo("x", vi.fn());
    expect((mocks.success.mock.calls[0]?.[1] as { action: { label: string } }).action.label).toBe("撤销");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
