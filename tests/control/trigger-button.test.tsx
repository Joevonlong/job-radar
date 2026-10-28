import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TriggerButton } from "@/components/control/trigger-button";
import type { ControlRequestView } from "@/lib/control/request-view-schema";

import en from "../../messages/en.json";

const actions = vi.hoisted(() => ({
  runChannelNowAction: vi.fn(),
  testChannelAction: vi.fn(),
  testAiAction: vi.fn(),
  testTelegramAction: vi.fn(),
}));
vi.mock("@/app/control-actions", () => actions);

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

const view = (over: Partial<ControlRequestView>): ControlRequestView => ({
  id: 7,
  kind: "test_channel",
  status: "done",
  requestedAt: "2026-10-08T10:00:00.000Z",
  startedAt: "2026-10-08T10:00:01.000Z",
  finishedAt: "2026-10-08T10:00:03.000Z",
  result: {},
  cycle: null,
  ...over,
});

let served: ControlRequestView;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(served), { status: 200, headers: { "content-type": "application/json" } })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TriggerButton", () => {
  it("tests a channel and shows the counts and sample titles of the finished request", async () => {
    const user = userEvent.setup();
    actions.testChannelAction.mockResolvedValue({ status: "queued", request: 7, kind: "test_channel", existing: false, nonce: 1 });
    served = view({ result: { channelId: "indeed", fetched: 5, parsed: 4, parseFailed: 1, sampleTitles: ["AI Engineer"], durationMs: 2300 } as ControlRequestView["result"] });
    render(wrap(<TriggerButton kind="testChannel" target="indeed" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(actions.testChannelAction).toHaveBeenCalledWith({ channelId: "indeed" });
    expect(await screen.findByText("5 fetched, 4 parsed (2.3 s, nothing stored)")).toBeInTheDocument();
    expect(screen.getByText("AI Engineer")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/control/requests/7", { cache: "no-store" });
  });

  it("asks before sending the Telegram test message, and shows a refusal of the server", async () => {
    const user = userEvent.setup();
    actions.testTelegramAction.mockResolvedValue({ status: "error", error: "tooSoon", retryAfterSeconds: 12, nonce: 1 });
    render(wrap(<TriggerButton kind="testTelegram" confirm />));
    await user.click(screen.getByRole("button", { name: "Send a Telegram test message" }));
    expect(actions.testTelegramAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions.testTelegramAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send a Telegram test message" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(actions.testTelegramAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("try again in 12 s");
  });

  it("shows a failed AI test by its code and kind", async () => {
    const user = userEvent.setup();
    actions.testAiAction.mockResolvedValue({ status: "queued", request: 9, kind: "test_ai", existing: false, nonce: 1 });
    served = view({ id: 9, kind: "test_ai", status: "failed", result: { error: "ai_test_failed", errorKind: "auth" } });
    render(wrap(<TriggerButton kind="testAi" target="claude-cli" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The call failed");
    expect(alert).toHaveTextContent("(auth)");
  });

  it("follows the running cycle that covers a collect request until that cycle finishes", async () => {
    const user = userEvent.setup();
    actions.runChannelNowAction.mockResolvedValue({ status: "queued", request: 11, kind: "run_cycle", existing: false, nonce: 1 });
    const progress = { id: 42, runsTotal: 6, runsFinished: 2, fetched: 30, newCount: 3 };
    served = view({ id: 11, kind: "run_cycle", result: { cycleId: 42, coveredBy: 42 }, cycle: { ...progress, status: "running" } });
    render(wrap(<TriggerButton kind="runChannel" target="indeed" />));
    await user.click(screen.getByRole("button", { name: "Collect now" }));
    const covered = await screen.findByText("Covered by the running cycle 42: 2 of 6 runs finished, 30 fetched");
    expect(covered).toHaveAttribute("data-outcome", "covered");
    // the request itself is done: the button is free again
    expect(screen.getByRole("button", { name: "Collect now" })).toBeEnabled();
    const calls = vi.mocked(fetch).mock.calls.length;
    served = view({ id: 11, kind: "run_cycle", result: { cycleId: 42, coveredBy: 42 }, cycle: { ...progress, runsFinished: 6, fetched: 55, newCount: 7, status: "succeeded" } });
    expect(await screen.findByText(/Cycle 42: .*55 fetched, 7 new/, undefined, { timeout: 6000 })).toHaveAttribute("data-outcome", "done");
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(calls);
    // and it stops polling once the cycle has finished
    const after = vi.mocked(fetch).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(vi.mocked(fetch).mock.calls.length).toBe(after);
  }, 15_000);

  it("is off when disabled and says why", () => {
    render(wrap(<TriggerButton kind="runChannel" target="xing" disabled disabledHint="switched off" />));
    expect(screen.getByRole("button", { name: "Collect now" })).toBeDisabled();
    expect(screen.getByText("switched off")).toBeInTheDocument();
  });
});
