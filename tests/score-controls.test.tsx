import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScoreNowButton } from "@/components/jobs/detail/score-now";
import { ActionsPanel } from "@/components/settings/actions-panel";
import type { ControlQueueView, ControlRequestView as PolledRequest } from "@/lib/control/request-view-schema";
import { controlStatusSchema, type ControlRequestView, type ControlStatus } from "@/lib/settings/status-schema";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const { scoreJobNowAction, scoreJobsAction, refresh } = vi.hoisted(() => ({ scoreJobNowAction: vi.fn(), scoreJobsAction: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/jobs/[id]/actions", () => ({ scoreJobNowAction }));
vi.mock("@/app/settings/actions", () => ({ scoreJobsAction, runCycleAction: vi.fn(), rescoreStaleAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/settings/constants", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settings/constants")>()), STATUS_POLL_MS: 10 }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

const NOW = "2026-10-07T12:00:00.000Z";
const request = (over: Partial<ControlRequestView> = {}): ControlRequestView => ({
  id: 5,
  kind: "score_jobs",
  status: "pending",
  requestedAt: NOW,
  startedAt: null,
  finishedAt: null,
  channelIds: null,
  jobIds: [7],
  error: null,
  scored: null,
  failed: null,
  placeholder: false,
  cycle: null,
  ...over,
});
const loaded = { state: "loaded" as const, loadedAt: NOW };
const status = (over: Partial<ControlStatus> = {}): ControlStatus => ({
  now: NOW,
  heartbeat: { at: NOW, ageSeconds: 2, online: true },
  staleScores: 0,
  unscoredJobs: 0,
  acks: { schedule: loaded, search: loaded, channels: loaded, ai: loaded, breakdown: loaded, notify: loaded, ui: loaded },
  requests: [],
  aiRun: null,
  ...over,
});

const queue = (over: Partial<ControlQueueView> = {}, worker: Partial<ControlQueueView["worker"]> = {}): ControlQueueView => ({
  ahead: 0,
  running: null,
  startedAt: null,
  now: NOW,
  ...over,
  worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 3, ...worker },
});
/** The score_jobs request as `/api/control/requests/5` serves it to the button. */
const polled = (over: Partial<PolledRequest> = {}): PolledRequest => ({
  id: 5,
  kind: "score_jobs",
  status: "pending",
  requestedAt: NOW,
  startedAt: null,
  finishedAt: null,
  result: {},
  cycle: null,
  queue: queue(),
  ...over,
});

let served: PolledRequest = polled();
beforeEach(() => {
  scoreJobNowAction.mockReset();
  scoreJobsAction.mockReset();
  refresh.mockReset();
  served = polled();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(served), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("ScoreNowButton (job detail)", () => {
  it("asks for the score of this job, polls that request, shows it is scoring and refreshes the page when it is done", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ status: "running", startedAt: NOW });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    expect(scoreJobNowAction).toHaveBeenCalledWith({ jobId: 7 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Scoring…" })).toBeDisabled());
    expect(fetch).toHaveBeenCalledWith("/api/control/requests/5", { cache: "no-store" });
    expect(refresh).not.toHaveBeenCalled();

    served = polled({ status: "done", startedAt: NOW, finishedAt: NOW, result: { scored: 1, failed: 0 }, queue: null });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("queued: the requests ahead and what the ai-worker is doing", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ queue: queue({ ahead: 4, running: { kind: "run_ai", since: "2026-10-28T11:20:00.000Z" } }) });
    render(wrap(<ScoreNowButton jobId={7} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("4 requests ahead of it."));
    expect(screen.getByTestId("queue-hint-running")).toHaveTextContent("The ai-worker is working on “AI stage of a cycle”, started 12:20.");
  });

  it("host: an offline ai-worker is said so (the runner's heartbeat plays no part), with a link to /sources", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ queue: queue({}, { process: "ai-worker", online: false, heartbeatAgeSeconds: 900 }) });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByTestId("queue-hint-offline")).toHaveTextContent("The ai-worker is offline (last heartbeat 15 min ago)."));
    expect(screen.getByTestId("queue-hint-sources")).toHaveAttribute("href", "/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scoring…" })).toBeDisabled());
  });

  it("host: an online ai-worker shows no offline line", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ queue: queue({ ahead: 1 }) });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByTestId("queue-hint-ahead")).toBeInTheDocument());
    expect(screen.queryByTestId("queue-hint-offline")).toBeNull();
  });

  it("shows why a request failed, and lets the user try again", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ status: "failed", finishedAt: NOW, result: { error: "score_failed" }, queue: null });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Scoring failed, see the ai-worker log"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Score now" })).toBeEnabled());
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["en", "zh"] as const)("a budget exhausted during preparation explains the one remaining job instead of a generic failure (%s)", async (locale) => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ status: "failed", startedAt: NOW, finishedAt: NOW, queue: null, result: { error: "score_stopped", scored: 0, failed: 0, remaining: 1, stopped: "time_budget" } });
    render(wrap(<ScoreNowButton jobId={7} />, locale));
    const button = screen.getByRole("button", { name: locale === "en" ? "Score now" : "立即打分" });
    await userEvent.click(button);
    expect(scoreJobNowAction).toHaveBeenCalledWith({ jobId: 7 });
    await waitFor(() => expect(screen.getByTestId("score-now-time-budget")).toHaveTextContent(locale === "en" ? "Stopped at the time budget: 1 still to score." : "到了时间预算，还剩 1 条没打分。"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("score-now-failed")).toBeNull();
    expect(button).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores an unknown stop reason from a newer worker", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    // a stop reason this page does not know (a newer worker) parses as none, not as an error
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ...polled({ status: "done", finishedAt: NOW, queue: null }), result: { scored: 1, failed: 0, remaining: 0, stopped: "something_new" } }), { status: 200 }));
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("score-now-time-budget")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is off with the reason and a link to /me while the profile is incomplete", () => {
    render(wrap(<ScoreNowButton jobId={7} profileMissing={["summary", "skills"]} />, "zh"));
    expect(screen.getByRole("button", { name: "立即打分" })).toBeDisabled();
    const note = screen.getByTestId("score-now-profile-incomplete");
    expect(note).toHaveTextContent("画像不完整，AI 打分已暂停");
    expect(note).toHaveTextContent("缺少：简介（summary）、技能（skills）");
    expect(screen.getByTestId("score-now-profile-link")).toHaveAttribute("href", "/me");
  });

  it.each([
    ["score_profile_incomplete", "the profile is incomplete, it has no summary and no skills"],
    ["score_ai_unavailable", "no AI provider is available"],
  ])("names the exact reason of a failed request: %s", async (error, text) => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = polled({ status: "failed", finishedAt: NOW, result: { error }, queue: null });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
    expect(screen.queryAllByTestId("score-now-profile-link")).toHaveLength(error === "score_profile_incomplete" ? 1 : 0);
  });

  it("shows a refusal of the service", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "error", error: "nothingToScore", nonce: 1 });
    render(wrap(<ScoreNowButton jobId={7} />, "zh"));
    await userEvent.click(screen.getByRole("button", { name: "立即打分" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("这个岗位现在不需要打分"));
  });
});

describe("ActionsPanel: score the backlog", () => {
  const panel = (s: ControlStatus | null) => wrap(<ActionsPanel status={s} onRequested={() => {}} channelChoices={[]} timezone="Europe/Berlin" />);

  it("offers a button with the number of unscored jobs and asks for the backlog", async () => {
    scoreJobsAction.mockResolvedValue({ status: "queued", request: 9, kind: "score_jobs", existing: false, nonce: 1 });
    render(panel(status({ unscoredJobs: 81 })));
    await userEvent.click(screen.getByRole("button", { name: "Score the 81 unscored jobs" }));
    expect(scoreJobsAction).toHaveBeenCalledWith({ backlog: true });
    await waitFor(() => expect(screen.getByText("Requested, waiting for the runner to pick it up.")).toBeInTheDocument());
  });

  it("is disabled when nothing waits, and while a backlog request is open (a request for one job does not block it)", () => {
    const { unmount } = render(panel(status({ unscoredJobs: 0 })));
    expect(screen.getByTestId("score-backlog-button")).toBeDisabled();
    unmount();

    const one = render(panel(status({ unscoredJobs: 5, requests: [request({ jobIds: [7] })] })));
    expect(screen.getByTestId("score-backlog-button")).toBeEnabled();
    one.unmount();

    render(panel(status({ unscoredJobs: 5, requests: [request({ jobIds: null, status: "running" })] })));
    expect(screen.getByTestId("score-backlog-button")).toBeDisabled();
  });

  it("a done request stopped at the time budget says how many are left; an unknown stop reason shows nothing", () => {
    const { unmount } = render(panel(status({ requests: [request({ kind: "rescore_stale", jobIds: null, status: "done", scored: 4, failed: 0, remaining: 12, stopped: "time_budget" })] })));
    expect(screen.getByTestId("control-request-time-budget")).toHaveTextContent("Stopped at the time budget: 12 still to score.");
    expect(screen.getByTestId("control-request")).toHaveTextContent("Re-score finished: 4 scored, 0 failed");
    unmount();
    render(panel(status({ requests: [request({ status: "done", scored: 1, failed: 0, remaining: 3 })] })));
    expect(screen.queryByTestId("control-request-time-budget")).toBeNull();
    // the browser's schema reads a stop reason it does not know as none
    const parsed = controlStatusSchema.parse({ ...status(), requests: [{ ...request({ status: "done" }), stopped: "something_new", remaining: 2 }] });
    expect(parsed.requests[0]).toMatchObject({ remaining: 2 });
    expect(parsed.requests[0]?.stopped).toBeUndefined();
  });

  it("shows a scoring request's budget remainder in Chinese", () => {
    render(wrap(<ActionsPanel status={status({ requests: [request({ kind: "rescore_stale", status: "done", remaining: 12, stopped: "time_budget" })] })} onRequested={() => {}} channelChoices={[]} timezone="Europe/Berlin" />, "zh"));
    expect(screen.getByTestId("control-request-time-budget")).toHaveTextContent("到了时间预算，还剩 12 条没打分。");
  });

  it.each(["score_jobs", "rescore_stale"] as const)("a %s budget exhausted during preparation takes priority over the generic stopped error", (kind) => {
    const remaining = kind === "score_jobs" ? 1 : 12;
    const stopped = status({ requests: [request({ kind, status: "failed", startedAt: NOW, finishedAt: NOW, jobIds: kind === "score_jobs" ? [7] : null, error: kind === "score_jobs" ? "score_stopped" : "rescore_stopped", scored: 0, failed: 0, remaining, stopped: "time_budget" })] });
    const { unmount } = render(panel(stopped));
    expect(screen.getByTestId("control-request-time-budget")).toHaveTextContent(`Stopped at the time budget: ${remaining} still to score.`);
    expect(screen.getByTestId("control-request")).not.toHaveTextContent("cancelled or AI unavailable");
    unmount();

    render(wrap(<ActionsPanel status={stopped} onRequested={() => {}} channelChoices={[]} timezone="Europe/Berlin" />, "zh"));
    expect(screen.getByTestId("control-request-time-budget")).toHaveTextContent(`到了时间预算，还剩 ${remaining} 条没打分。`);
    expect(screen.getByTestId("control-request")).not.toHaveTextContent("被取消或 AI 不可用");
  });

  it("lists the request with its jobs and its outcome", () => {
    render(panel(status({ requests: [request({ status: "done", scored: 3, failed: 1 })] })));
    const row = screen.getByTestId("control-request");
    expect(row).toHaveAttribute("data-kind", "score_jobs");
    expect(row).toHaveTextContent("Score jobs");
    expect(row).toHaveTextContent("Jobs: #7");
    expect(row).toHaveTextContent("Scoring finished: 3 scored, 1 failed");
  });
});
