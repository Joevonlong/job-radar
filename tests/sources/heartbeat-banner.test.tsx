import { render, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "zh" as "zh" | "en" }));

vi.mock("next-intl/server", () => {
  const messages = { zh, en } as const;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: messages[state.locale] as never, namespace: namespace as never }),
  };
});

import { HeartbeatBanner } from "@/components/sources/heartbeat-banner";
import type { AiWorkerStatus } from "@/lib/ops/ai-worker";

const runner = (over: Partial<{ ageSeconds: number | null; online: boolean }> = {}) => ({ lastHeartbeatAt: null, ageSeconds: 10, online: true, intervalSeconds: 30, ...over });
const worker = (over: Partial<AiWorkerStatus> = {}): AiWorkerStatus =>
  ({ execution: "host", online: true, ageSeconds: 5, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun: null, ...over }) as AiWorkerStatus;

describe("the heartbeat banner of /sources", () => {
  it("says nothing while both programs answer, and ignores the ai-worker when AI runs in the container", async () => {
    state.locale = "zh";
    expect(await HeartbeatBanner({ runner: runner(), aiWorker: worker() })).toBeNull();
    expect(await HeartbeatBanner({ runner: runner(), aiWorker: worker({ execution: "container", online: false }) })).toBeNull();
  });

  it("names the real silence of each program, what waits and what to do", async () => {
    state.locale = "zh";
    render((await HeartbeatBanner({ runner: runner({ online: false, ageSeconds: 40 * 60 }), aiWorker: worker({ online: false, ageSeconds: 53 * 60 }) })) as React.ReactElement);
    expect(screen.getByTestId("heartbeat-runner")).toHaveTextContent("runner 已 40 分钟没有心跳");
    expect(screen.getByTestId("heartbeat-runner")).toHaveTextContent("重新启动 runner");
    expect(screen.getByTestId("heartbeat-ai-worker")).toHaveTextContent("ai-worker 已 53 分钟没有心跳");
    expect(screen.getByTestId("heartbeat-ai-worker")).toHaveTextContent("打分、翻译和推送");
    expect(screen.getByTestId("heartbeat-warning").textContent).not.toMatch(/180|launchd|pnpm/);
  });

  it("only the program that is silent is named", async () => {
    state.locale = "en";
    render((await HeartbeatBanner({ runner: runner(), aiWorker: worker({ online: false, ageSeconds: null }) })) as React.ReactElement);
    expect(screen.queryByTestId("heartbeat-runner")).toBeNull();
    expect(screen.getByTestId("heartbeat-ai-worker")).toHaveTextContent("ai-worker has not reported yet");
  });
});
