import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { QuickFilter } from "@/components/jobs/quick-filter";

import en from "../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

const props = { href: "/?hideLang=true", offLabel: "Hide German-required", onLabel: "German hidden", removeLabel: "Show German-required", testId: "toggle-hide-german" };

function renderFilter(active: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <QuickFilter {...props} active={active} />
    </NextIntlClientProvider>,
  );
}

describe("QuickFilter semantics", () => {
  it("is a plain link without aria-pressed (links do not support it) while off", () => {
    renderFilter(false);
    const link = screen.getByTestId("toggle-hide-german");
    expect(link.tagName).toBe("A");
    expect(link).not.toHaveAttribute("aria-pressed");
    expect(link).not.toHaveAttribute("aria-current");
    expect(link).toHaveAttribute("data-active", "false");
  });

  it("marks the active link with aria-current instead of aria-pressed", () => {
    renderFilter(true);
    const link = screen.getByTestId("toggle-hide-german");
    expect(link).not.toHaveAttribute("aria-pressed");
    expect(link).toHaveAttribute("aria-current", "true");
    expect(link).toHaveAttribute("data-active", "true");
  });
});
