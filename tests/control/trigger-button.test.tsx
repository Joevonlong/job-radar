import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TriggerButton } from "@/components/control/trigger-button";
import type { ControlQueueView, ControlRequestView } from "@/lib/control/request-view-schema";

import en from "../../messages/en.json";

const actions = vi.hoisted(() => ({
  runChannelNowAction: vi.fn(),
  testChannelAction: vi.fn(),
  testAiAction: vi.fn(),
  testTelegramAction: vi.fn(),
}));
vi.mock("@/app/control-actions", () => actions);
vi.mock("@/lib/settings/constants", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settings/constants")>()), STATUS_POLL_MS: 10 }));

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
  queue: null,
  ...over,
});

const queue = (over: Partial<ControlQueueView> = {}, worker: Partial<ControlQueueView["worker"]> = {}): ControlQueueView => ({
  ahead: 0,
  running: null,
  startedAt: null,
  now: "2026-10-28T12:00:00.000Z",
  ...over,
  worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 3, ...worker },
});

let served: ControlRequestView | null;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      served === null ? new Response(JSON.stringify({ error: "not found" }), { status: 404 }) : new Response(JSON.stringify(served), { status: 200, headers: { "content-type": "application/json" } }),
    ),
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

  it("queued: names the process from the queue view (the runner for an AI test with execution: container), with the requests ahead and what runs", async () => {
    const user = userEvent.setup();
    actions.testAiAction.mockResolvedValue({ status: "queued", request: 9, kind: "test_ai", existing: false, nonce: 1 });
    served = view({ id: 9, kind: "test_ai", status: "pending", finishedAt: null, startedAt: null, queue: queue({ ahead: 2, running: { kind: "run_cycle", since: "2026-10-28T11:40:00.000Z" } }, { process: "runner" }) });
    render(wrap(<TriggerButton kind="testAi" target="claude-cli" timeZone="Europe/Berlin" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("trigger-outcome")).toHaveTextContent("Queued, waiting for the runner…"));
    expect(screen.getByTestId("trigger-outcome")).toHaveAttribute("data-process", "runner");
    expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("2 requests ahead of it.");
    expect(screen.getByTestId("queue-hint-running")).toHaveTextContent("The runner is working on “Manual cycle”, started 12:40.");
    expect(screen.getByTestId("trigger-testAi")).toHaveAttribute("data-state", "busy");
  });

  it("host: the same AI test waits for the ai-worker", async () => {
    const user = userEvent.setup();
    actions.testAiAction.mockResolvedValue({ status: "queued", request: 9, kind: "test_ai", existing: false, nonce: 1 });
    served = view({ id: 9, kind: "test_ai", status: "pending", finishedAt: null, startedAt: null, queue: queue() });
    render(wrap(<TriggerButton kind="testAi" target="claude-cli" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("trigger-outcome")).toHaveTextContent("Queued, waiting for the ai-worker on the host…"));
  });

  it("offline: the hint and a link to /sources while the button stays busy and keeps polling", async () => {
    const user = userEvent.setup();
    actions.testChannelAction.mockResolvedValue({ status: "queued", request: 7, kind: "test_channel", existing: false, nonce: 1 });
    served = view({ status: "pending", finishedAt: null, startedAt: null, queue: queue({}, { process: "runner", online: false, heartbeatAgeSeconds: 300 }) });
    render(wrap(<TriggerButton kind="testChannel" target="indeed" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("queue-hint-offline")).toHaveTextContent("The runner is offline (last heartbeat 5 min ago)."));
    expect(screen.getByTestId("queue-hint-sources")).toHaveAttribute("href", "/sources");
    expect(screen.getByTestId("trigger-testChannel")).toHaveAttribute("data-state", "busy");
    const calls = vi.mocked(fetch).mock.calls.length;
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(calls + 2));
    // the process is back: the request runs and finishes
    served = view({ result: { fetched: 1, parsed: 1, durationMs: 100 } });
    expect(await screen.findByText("1 fetched, 1 parsed (0.1 s, nothing stored)")).toBeInTheDocument();
  });

  it("running: its own start and how long it runs", async () => {
    const user = userEvent.setup();
    actions.testChannelAction.mockResolvedValue({ status: "queued", request: 7, kind: "test_channel", existing: false, nonce: 1 });
    served = view({ status: "running", finishedAt: null, queue: queue({ startedAt: "2026-10-28T11:58:00.000Z" }, { process: "runner" }) });
    render(wrap(<TriggerButton kind="testChannel" target="indeed" timeZone="Europe/Berlin" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("queue-hint-self")).toHaveTextContent("Running since 12:58, for 2 minutes."));
    expect(screen.getByTestId("trigger-outcome")).toHaveAttribute("data-outcome", "running");
  });

  it("a request that is gone (404) ends as failed instead of waiting for ever", async () => {
    const user = userEvent.setup();
    actions.testChannelAction.mockResolvedValue({ status: "queued", request: 7, kind: "test_channel", existing: false, nonce: 1 });
    served = null;
    render(wrap(<TriggerButton kind="testChannel" target="indeed" />));
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("trigger-outcome")).toHaveAttribute("data-outcome", "failed"));
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    const calls = vi.mocked(fetch).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });

  it("is off when disabled and says why", () => {
    render(wrap(<TriggerButton kind="runChannel" target="xing" disabled disabledHint="switched off" />));
    expect(screen.getByRole("button", { name: "Collect now" })).toBeDisabled();
    expect(screen.getByText("switched off")).toBeInTheDocument();
  });
});
