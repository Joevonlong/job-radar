import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { Component, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { TriggerButton } from "@/components/control/trigger-button";

import en from "../../messages/en.json";

const actions = vi.hoisted(() => ({ runChannelNowAction: vi.fn(), testChannelAction: vi.fn(), testAiAction: vi.fn(), testTelegramAction: vi.fn() }));
vi.mock("@/app/control-actions", () => actions);

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div data-testid="page-error" /> : this.props.children; }
}

afterEach(() => vi.restoreAllMocks());

it("catches an outdated action before it replaces the page, and requests update recovery", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  actions.testChannelAction.mockRejectedValue(new UnrecognizedActionError("old action"));
  const recover = vi.fn();
  window.addEventListener("jobradar:action-failure", recover);
  try {
    render(<NextIntlClientProvider locale="en" messages={en}><Boundary><TriggerButton kind="testChannel" target="indeed" /></Boundary></NextIntlClientProvider>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(recover).toHaveBeenCalled());
    expect(screen.queryByTestId("page-error")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  } finally {
    window.removeEventListener("jobradar:action-failure", recover);
  }
});
