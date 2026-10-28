import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslationPanel, type TranslationView } from "@/components/jobs/detail/translation-panel";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import en from "../messages/en.json";
import zh from "../messages/zh.json";

/** How the English interface names the Chinese target language (the page passes it in). */
const EN_TARGET = { name: "Chinese", lang: "zh-CN" };

const { translateJobAction, translateStatusAction } = vi.hoisted(() => ({ translateJobAction: vi.fn(), translateStatusAction: vi.fn() }));
vi.mock("@/app/jobs/[id]/actions", () => ({ translateJobAction, translateStatusAction }));
// the tab polls the queued request: poll fast (there is no wait limit; the queue view says when the worker is offline)
vi.mock("@/lib/settings/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/constants")>()),
  STATUS_POLL_MS: 10,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

const view = (over: Partial<TranslationView> = {}): TranslationView => ({
  content: "## 我们提供\n\n- [[T1]]年薪 9 万欧元[[/T1]]\n- 远程办公\n\n加入我们。",
  provider: "codex-cli",
  createdAt: "2026-10-07T10:00:00.000Z",
  stale: false,
  ...over,
});

beforeEach(() => {
  translateJobAction.mockReset();
  translateStatusAction.mockReset();
});

/** A queue view as the status action returns it (times in UTC; the panel shows them in Europe/Berlin, UTC+1 in late October). */
const queue = (over: Partial<ControlQueueView> = {}, worker: Partial<ControlQueueView["worker"]> = {}): ControlQueueView => ({
  ahead: 0,
  running: null,
  startedAt: null,
  now: "2026-10-28T12:00:00.000Z",
  ...over,
  worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 3, ...worker },
});

const done = (translation: TranslationView) => ({ ok: true, queued: false, cached: false, translation });

describe("TranslationPanel", () => {
  it("shows a cached translation with highlight, legend and provenance, and no button", () => {
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={1} hasDescription initial={view()} timeZone="Europe/Berlin" categories={[{ id: "T1", color: "amber" }]} />));
    expect(screen.getByRole("heading", { name: "我们提供" })).toBeInTheDocument();
    const mark = screen.getByText("年薪 9 万欧元");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveAttribute("title", "T1");
    expect(mark.className).toContain("bg-signal-t1");
    expect(screen.getByTestId("translation-body")).toHaveAttribute("lang", "zh-CN");
    expect(screen.getByText("Highlight = translation of a quoted signal sentence")).toBeInTheDocument();
    expect(screen.getByTestId("translation-note")).toHaveTextContent("machine translated by codex-cli");
    expect(screen.queryByTestId("translate-button")).toBeNull();
    expect(screen.queryByText(/\[\[/)).toBeNull();
  });

  it("without a translation offers the button; clicking shows the loading state, then the result", async () => {
    let resolve: (value: unknown) => void = () => {};
    translateJobAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={7} hasDescription initial={null} timeZone="Europe/Berlin" />));
    const button = screen.getByRole("button", { name: "Translate to Chinese" });
    await userEvent.click(button);

    expect(translateJobAction).toHaveBeenCalledWith({ jobId: 7, force: false });
    const busy = screen.getByRole("button", { name: "Translating…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("translation-loading")).toHaveTextContent("Translating the JD with AI");

    await act(async () => resolve(done(view({ content: "译文第一段。" }))));
    await waitFor(() => expect(screen.getByText("译文第一段。")).toBeInTheDocument());
    expect(screen.queryByTestId("translate-button")).toBeNull();
    expect(screen.queryByTestId("translation-loading")).toBeNull();
  });

  it("shows an error message and lets the user retry", async () => {
    translateJobAction.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={7} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("translation-error")).toHaveTextContent("No AI provider is available"));
    expect(screen.getByTestId("translate-button")).toBeEnabled();
    translateJobAction.mockResolvedValueOnce(done(view({ content: "好了。" })));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByText("好了。")).toBeInTheDocument());
    expect(screen.queryByTestId("translation-error")).toBeNull();
  });

  it("treats a rejected action like a failure", async () => {
    translateJobAction.mockRejectedValueOnce(new Error("network"));
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={7} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("translation-error")).toHaveTextContent("The translation failed"));
  });

  it("flags an outdated translation, keeps showing it and re-translates with force", async () => {
    translateJobAction.mockResolvedValue(done(view({ content: "新译文。" })));
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={3} hasDescription initial={view({ content: "旧译文。", stale: true })} timeZone="Europe/Berlin" />));
    expect(screen.getByTestId("translation-stale")).toHaveTextContent("The JD changed after this translation was made");
    expect(screen.getByText("旧译文。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Translate again" }));
    expect(translateJobAction).toHaveBeenCalledWith({ jobId: 3, force: true });
    await waitFor(() => expect(screen.getByText("新译文。")).toBeInTheDocument());
    expect(screen.queryByTestId("translation-stale")).toBeNull();
  });

  it("queues the request for the ai-worker, shows it as waiting and then runs, and polls until the translation is there", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 41 });
    translateStatusAction
      .mockResolvedValueOnce({ ok: true, state: "waiting", stage: "pending", partial: null, queue: queue() })
      .mockResolvedValueOnce({ ok: true, state: "waiting", stage: "running", partial: null, queue: queue() })
      .mockResolvedValue({ ok: true, state: "done", translation: view({ content: "排队后的译文。" }) });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    expect(screen.getByTestId("translation-loading")).toHaveAttribute("data-stage", "pending");
    expect(screen.getByTestId("translation-loading")).toHaveTextContent("The request is queued for the AI worker on this Mac");
    await waitFor(() => expect(screen.getByTestId("translation-loading")).toHaveAttribute("data-stage", "running"));
    await waitFor(() => expect(screen.getByText("排队后的译文。")).toBeInTheDocument());
    expect(translateStatusAction).toHaveBeenCalledWith({ jobId: 9, requestId: 41 });
    expect(screen.queryByTestId("translation-loading")).toBeNull();
  });

  it("shows the reason when the queued translation fails", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 5 });
    translateStatusAction.mockResolvedValue({ ok: false, error: "unavailable" });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("translation-error")).toHaveTextContent("No AI provider is available"));
    expect(screen.getByTestId("translate-button")).toBeEnabled();
  });

  it("waiting: shows how many requests are ahead and what the ai-worker is doing, then its own start once it runs", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 5 });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    translateStatusAction
      .mockResolvedValueOnce({ ok: true, state: "waiting", stage: "pending", partial: null, queue: queue({ ahead: 2, running: { kind: "run_ai", since: "2026-10-28T11:15:00.000Z" } }) })
      .mockImplementation(async () => {
        await released;
        return { ok: true, state: "waiting", stage: "running", partial: null, queue: queue({ startedAt: "2026-10-28T11:48:00.000Z" }) };
      });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("2 requests ahead of it."));
    expect(screen.getByTestId("queue-hint-running")).toHaveTextContent("The ai-worker is working on “AI stage of a cycle”, started 12:15.");
    expect(screen.getByTestId("queue-hint")).toHaveAttribute("role", "status");
    release();
    await waitFor(() => expect(screen.getByTestId("queue-hint-self")).toHaveTextContent("Running since 12:48, for 12 minutes."));
    expect(screen.queryByTestId("queue-hint-ahead")).toBeNull();
  });

  it("offline: a line with the last heartbeat and a link to /sources; the tab keeps its waiting state and keeps polling", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 5 });
    translateStatusAction.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: true, state: "waiting", stage: "pending", partial: null, queue: queue({}, { online: false, heartbeatAgeSeconds: 900 }) });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("queue-hint-offline")).toHaveTextContent("The ai-worker is offline (last heartbeat 15 min ago)."));
    expect(screen.getByTestId("queue-hint-sources")).toHaveAttribute("href", "/sources");
    expect(screen.getByTestId("translation-loading")).toHaveAttribute("data-stage", "pending");
    const calls = translateStatusAction.mock.calls.length;
    await waitFor(() => expect(translateStatusAction.mock.calls.length).toBeGreaterThan(calls + 2));
    expect(screen.queryByTestId("translation-error")).toBeNull();
  });

  it("with no heartbeat at all the worker is offline at once, after a reload too (the queue the page was rendered with)", () => {
    translateStatusAction.mockReturnValue(new Promise(() => {}));
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} initialRequest={{ requestId: 5, stage: "pending", queue: queue({ ahead: 1 }, { online: false, heartbeatAgeSeconds: null }) }} timeZone="Europe/Berlin" />));
    expect(screen.getByTestId("queue-hint-offline")).toHaveTextContent("The ai-worker is offline (no heartbeat yet).");
    expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("1 request ahead of it.");
  });

  it("the partial text shows while the request still waits, also in Chinese", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 8 });
    translateStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "running", partial: { content: "第一段译文。", done: 1, total: 3 }, queue: queue({ startedAt: "2026-10-28T11:59:30.000Z" }) });
    render(wrap(<TranslationPanel target={{ name: "中文", lang: "zh-CN" }} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />, "zh"));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("translation-partial-body")).toHaveTextContent("第一段译文。"));
    expect(screen.getByTestId("queue-hint-self")).toHaveTextContent("处理中，12:59 开始，已进行 不到 1 分钟。");
  });

  it("shows how far a queued translation is, with the pieces done so far", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 8 });
    // the last answer is held back until the test has looked at the partial state: with real timers a loaded machine
    // could otherwise poll straight through "2/4" to "done" between two checks
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    translateStatusAction
      .mockResolvedValueOnce({ ok: true, state: "waiting", stage: "running", partial: { content: "第一段译文。", done: 1, total: 4 }, queue: queue() })
      .mockResolvedValueOnce({ ok: true, state: "waiting", stage: "running", partial: { content: "第一段译文。\n\n第二段译文。", done: 2, total: 4 }, queue: queue() })
      .mockImplementation(async () => {
        await released;
        return { ok: true, state: "done", translation: view({ content: "全部译文。" }) };
      });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("translation-loading")).toHaveTextContent("Translating (2/4)…"));
    expect(screen.getByTestId("translation-partial-body")).toHaveTextContent("第二段译文。");
    // running: the banner reads as progress, not as a partial failure
    expect(screen.getByTestId("translation-partial")).toHaveTextContent("Translating now: 2 of 4 parts done");
    expect(screen.getByRole("note")).toHaveAttribute("data-busy", "true");
    release();
    await waitFor(() => expect(screen.getByText("全部译文。")).toBeInTheDocument());
    expect(screen.queryByTestId("translation-partial")).toBeNull();
  });

  it("a failed attempt keeps the partial text, names the real cause and offers to continue", async () => {
    translateJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 8 });
    translateStatusAction.mockResolvedValueOnce({ ok: false, error: "timeout", detail: "claude-cli: timeout; codex-cli: provider_error", partial: { content: "第一段译文。", done: 1, total: 4 } });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByTestId("translation-error")).toHaveTextContent("did not answer in time"));
    expect(screen.getByTestId("translation-error")).not.toHaveTextContent("No AI provider is available");
    expect(screen.getByTestId("translation-error-detail")).toHaveTextContent("claude-cli: timeout; codex-cli: provider_error");
    expect(screen.getByTestId("translation-partial")).toHaveAttribute("data-done", "1");
    expect(screen.getByTestId("translation-partial")).toHaveTextContent("stopped at 1 of 4 parts");
    expect(screen.getByText("第一段译文。")).toBeInTheDocument();

    translateJobAction.mockResolvedValue(done(view({ content: "补完了。" })));
    await userEvent.click(screen.getByRole("button", { name: "Continue translating" }));
    expect(translateJobAction).toHaveBeenLastCalledWith({ jobId: 9, force: false });
    await waitFor(() => expect(screen.getByText("补完了。")).toBeInTheDocument());
  });

  it("shows the pieces and the cause of an earlier failed attempt right after the page loads", () => {
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} initialPartial={{ content: "第一段译文。", done: 2, total: 5, errorCode: "auth", errorDetail: "claude-cli: auth" }} timeZone="Europe/Berlin" />));
    expect(screen.getByTestId("translation-partial")).toHaveAttribute("data-total", "5");
    expect(screen.getByTestId("translation-error")).toHaveTextContent("login has expired");
    expect(screen.getByRole("button", { name: "Continue translating" })).toBeEnabled();
  });

  it("without any piece a failure offers a plain retry", async () => {
    translateJobAction.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={9} hasDescription initial={null} timeZone="Europe/Berlin" />));
    await userEvent.click(screen.getByTestId("translate-button"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
  });

  it("has nothing to offer for a job without JD text", () => {
    render(wrap(<TranslationPanel target={EN_TARGET} jobId={1} hasDescription={false} initial={null} timeZone="Europe/Berlin" />));
    expect(screen.getByTestId("translation-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("translate-button")).toBeNull();
  });

  it("renders in Chinese", () => {
    render(wrap(<TranslationPanel target={{ name: "中文", lang: "zh-CN" }} jobId={1} hasDescription initial={null} timeZone="Europe/Berlin" />, "zh"));
    expect(screen.getByRole("button", { name: "翻译成中文" })).toBeInTheDocument();
  });

  it("names any configured target language and tags the text with it", () => {
    render(wrap(<TranslationPanel target={{ name: "German", lang: "de" }} jobId={1} hasDescription initial={view()} timeZone="Europe/Berlin" />));
    expect(screen.getByTestId("translation-body")).toHaveAttribute("lang", "de");
    expect(screen.getByTestId("translation-note")).toHaveTextContent(/^German translation · machine translated by/);
  });
});
