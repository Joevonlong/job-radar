import { act, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFavoriteToggle } from "@/components/favorites/use-favorite-toggle";

import en from "../../messages/en.json";

const mocks = vi.hoisted(() => ({ setFavoriteAction: vi.fn(), restoreFavoriteAction: vi.fn() }));
vi.mock("@/app/favorites/actions", () => mocks);
vi.mock("@/lib/toast", () => ({ toastTone: vi.fn(), toastUndo: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {children}
  </NextIntlClientProvider>
);

beforeEach(() => vi.clearAllMocks());

describe("useFavoriteToggle", () => {
  it("a press while the server is still answering the one before is not dropped: the last wish is sent afterwards", async () => {
    let release: () => void = () => {};
    mocks.setFavoriteAction.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ ok: true, removed: null }))));
    mocks.setFavoriteAction.mockResolvedValue({ ok: true, removed: null });
    const { result } = renderHook(() => useFavoriteToggle([{ id: 7, favorite: false }]), { wrapper });
    const subject = { id: 7, title: "LLM Engineer" };
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.toggle(subject, true);
    });
    await act(async () => {
      await result.current.toggle(subject, false);
    });
    expect(result.current.isFavorite({ id: 7, favorite: false })).toBe(false);
    expect(mocks.setFavoriteAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await first;
    });
    expect(mocks.setFavoriteAction.mock.calls.map(([arg]) => arg.favorite)).toEqual([true, false]);
  });
  it("isSaving is true from the press until the server answered, also across a queued press", async () => {
    let release: () => void = () => {};
    mocks.setFavoriteAction.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ ok: true, removed: null }))));
    mocks.setFavoriteAction.mockResolvedValue({ ok: true, removed: null });
    const { result } = renderHook(() => useFavoriteToggle([{ id: 7, favorite: false }]), { wrapper });
    const subject = { id: 7, title: "LLM Engineer" };
    expect(result.current.isSaving(subject)).toBe(false);
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.toggle(subject, true);
    });
    expect(mocks.setFavoriteAction).toHaveBeenCalledTimes(1);
    expect(result.current.isSaving(subject)).toBe(true);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.isSaving(subject)).toBe(false);
  });
});
