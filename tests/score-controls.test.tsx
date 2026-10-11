import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScoreNowButton } from "@/components/jobs/detail/score-now";
import { ActionsPanel } from "@/components/settings/actions-panel";
import type { ControlRequestView, ControlStatus } from "@/lib/settings/status-schema";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const { scoreJobNowAction, scoreJobsAction, refresh } = vi.hoisted(() => ({ scoreJobNowAction: vi.fn(), scoreJobsAction: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/jobs/[id]/actions", () => ({ scoreJobNowAction }));
vi.mock("@/app/settings/actions", () => ({ scoreJobsAction, runCycleAction: vi.fn(), rescoreStaleAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

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

let served: ControlStatus = status();
beforeEach(() => {
  scoreJobNowAction.mockReset();
  scoreJobsAction.mockReset();
  refresh.mockReset();
  served = status();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(served), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("ScoreNowButton (job detail)", () => {
  it("asks for the score of this job, shows it is scoring and refreshes the page when the request is done", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = status({ requests: [request({ status: "running" })] });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    expect(scoreJobNowAction).toHaveBeenCalledWith({ jobId: 7 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Scoring…" })).toBeDisabled());
    expect(refresh).not.toHaveBeenCalled();

    served = status({ requests: [request({ status: "done", scored: 1, failed: 0 })] });
    // the next poll (every 2 s) sees the finished request
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  }, 10_000);

  it("says so when the runner is not answering", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = status({ heartbeat: { at: NOW, ageSeconds: 900, online: false }, requests: [request()] });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The runner is not responding"));
  });

  it("shows why a request failed, and lets the user try again", async () => {
    scoreJobNowAction.mockResolvedValue({ status: "queued", request: 5, kind: "score_jobs", existing: false, nonce: 1 });
    served = status({ requests: [request({ status: "failed", error: "score_failed" })] });
    render(wrap(<ScoreNowButton jobId={7} />));
    await userEvent.click(screen.getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Scoring failed, see the ai-worker log"));
    // the failure can show while the click's transition is still "Requesting…": wait for the button to come back
    await waitFor(() => expect(screen.getByRole("button", { name: "Score now" })).toBeEnabled());
    expect(refresh).not.toHaveBeenCalled();
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
    served = status({ requests: [request({ status: "failed", error })] });
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

  it("lists the request with its jobs and its outcome", () => {
    render(panel(status({ requests: [request({ status: "done", scored: 3, failed: 1 })] })));
    const row = screen.getByTestId("control-request");
    expect(row).toHaveAttribute("data-kind", "score_jobs");
    expect(row).toHaveTextContent("Score jobs");
    expect(row).toHaveTextContent("Jobs: #7");
    expect(row).toHaveTextContent("Scoring finished: 3 scored, 1 failed");
  });
});
