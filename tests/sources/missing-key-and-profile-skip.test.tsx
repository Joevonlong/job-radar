import { render, screen } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "zh" as "zh" | "en" }));

vi.mock("next-intl/server", () => {
  const messages = { zh, en } as const;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: messages[state.locale] as never, namespace: namespace as never }),
    getFormatter: async () => ({ dateTime: () => "12:00" }),
  };
});

import { CycleSummaryStrip } from "@/components/jobs/cycle-summary";
import { AiWorkerCard } from "@/components/sources/ai-worker-card";
import type { CycleSummary } from "@/lib/db/queries/today";
import type { AiWorkerStatus, LastRunAi } from "@/lib/ops/ai-worker";
import { missingEnvOfEnabled } from "@/lib/sources/required-env";

import { shippedChannels } from "../channels/helpers";

const NOW = new Date("2026-10-07T12:00:00Z");

function summary(): CycleSummary {
  const channel = (channelId: string) => ({ channelId, family: channelId, runs: 1, fetched: 0, newCount: 0, outcome: "ok" as const, errorCode: null, circuitOpenUntil: null });
  return {
    id: 5,
    kind: "manual",
    status: "succeeded",
    startedAt: NOW,
    finishedAt: NOW,
    channels: [channel("brave"), channel("jsearch")],
    newCount: 0,
    mergedCount: null,
    fetched: 0,
    failedChannels: 0,
    passedCount: 0,
    qualifiedCount: null,
    steps: [],
    unprocessed: 0,
  };
}

describe("Today channel chips: missing key", () => {
  it("shows the warning state and the variable name, only for the channel that lacks it", async () => {
    state.locale = "zh";
    const ui = await CycleSummaryStrip({ summary: summary(), next: null, timezone: "Europe/Berlin", now: NOW, missingEnv: { brave: ["BRAVE_SEARCH_API_KEY"] } });
    const { container } = render(ui);
    const brave = container.querySelector('[data-channel="brave"]')!;
    expect(brave.getAttribute("data-missing-env")).toBe("BRAVE_SEARCH_API_KEY");
    expect(brave.textContent).toContain("缺 BRAVE_SEARCH_API_KEY");
    expect(brave.querySelector("span[aria-hidden]")!.className).toContain("bg-warning");
    const jsearch = container.querySelector('[data-channel="jsearch"]')!;
    expect(jsearch.getAttribute("data-missing-env")).toBeNull();
    expect(jsearch.querySelector("span[aria-hidden]")!.className).toContain("bg-success");
  });

  it("missingEnvOfEnabled lists names for enabled channels only", () => {
    const config = shippedChannels();
    const on = { ...config, sources: { ...config.sources, brave: { ...config.sources.brave, enabled: true }, jsearch: { ...config.sources.jsearch, enabled: false } } };
    expect(missingEnvOfEnabled(on, {}, ["brave", "jsearch", "unknown-channel"])).toEqual({ brave: ["BRAVE_SEARCH_API_KEY"] });
    expect(missingEnvOfEnabled(on, { BRAVE_SEARCH_API_KEY: "x" }, ["brave"])).toEqual({});
    const off = { ...on, sources: { ...on.sources, brave: { ...on.sources.brave, enabled: false } } };
    expect(missingEnvOfEnabled(off, {}, ["brave"])).toEqual({});
  });
});

/** The block draws a Led (a client-side translation hook), so it needs the provider a page gets from the layout. */
async function renderCard(status: AiWorkerStatus, locale: "zh" | "en") {
  const ui = await AiWorkerCard({ worker: status, timeZone: "Europe/Berlin" });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {ui}
    </NextIntlClientProvider>,
  );
}

function worker(lastRun: LastRunAi): AiWorkerStatus {
  return { execution: "host", online: true, lastHeartbeatAt: NOW, ageSeconds: 5, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun };
}

const run = (aiStatus: string | null): LastRunAi => ({ requestId: 1, status: "done", finishedAt: NOW, cycleId: 7, error: null, aiStatus, scored: 0, translated: 0, notifyStatus: null, pushed: 0 });

describe("/sources AI worker card: profile skip", () => {
  it.each([
    ["zh" as const, "画像不完整，打分已暂停"],
    ["en" as const, "profile incomplete, scoring paused"],
  ])("says so explicitly with a link to /me (%s)", async (locale, text) => {
    state.locale = locale;
    await renderCard(worker(run("skipped_profile_incomplete")), locale);
    const line = screen.getByTestId("ai-worker-profile-skip");
    expect(line.textContent).toContain(text);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/me");
    expect(screen.queryByTestId("ai-worker-last-run")).toBeNull();
  });

  it("keeps the generic last-run text for other statuses", async () => {
    state.locale = "zh";
    await renderCard(worker(run("done")), "zh");
    expect(screen.getByTestId("ai-worker-last-run")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-worker-profile-skip")).toBeNull();
  });
});
