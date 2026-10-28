import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BreakdownPanel, type BreakdownPanelProps } from "@/components/jobs/detail/breakdown-panel";
import { JD_JUMP_EVENT } from "@/components/jobs/detail/marks";
import type { BreakdownView } from "@/lib/breakdown/view";
import type { ControlQueueView } from "@/lib/control/request-view-schema";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const { breakdownJobAction, breakdownStatusAction, refresh } = vi.hoisted(() => ({ breakdownJobAction: vi.fn(), breakdownStatusAction: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/jobs/[id]/breakdown-actions", () => ({ breakdownJobAction, breakdownStatusAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
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

const q = (quote: string, quoteIndex: number | null) => ({ quote, quoteIndex });
const tech = (name: string, category: "languages" | "cloud_infra", requirement: "must" | "nice", have: boolean | null, quoteIndex: number | null = 0) => ({ name, category, requirement, have, ...q("Our stack: Python and Kubernetes", quoteIndex) });

function view(over: Partial<BreakdownView> = {}): BreakdownView {
  const python = tech("Python", "languages", "must", true);
  const kube = tech("Kubernetes", "cloud_infra", "nice", false);
  const aws = tech("AWS", "cloud_infra", "must", false, null);
  return {
    meta: { provider: "codex-cli", model: "gpt-5.5", modelByCliDefault: false, promptVersion: "breakdown-v1", analyzedAt: "2026-10-08T12:02:00.000Z", dropped: 0, outputLang: "zh" },
    stale: { jd: false, prompt: false, lang: false },
    content: {
      total: 8,
      responsibilities: [{ text: "构建检索管线", requirement: null, ...q("Build pipelines.", 1) }, { text: "写文档", requirement: null, ...q("Write docs.", null) }],
      techGroups: [
        { category: "languages", items: [python] },
        { category: "cloud_infra", items: [aws, kube] },
      ],
      experience: { yearsMin: 5, years: q("5+ years", 2), items: [{ text: "软件工程", requirement: "must", ...q("software engineering", 3) }] },
      projects: [],
      softSkills: [{ text: "沟通", requirement: "nice", ...q("communication", 4) }],
      other: [],
      languages: [{ text: "English", requirement: "must", language: "English", level: "C1", ...q("Fluent English", 5) }],
    },
    match: { state: "ok", must: { have: 1, total: 2 }, nice: { have: 0, total: 1 }, missing: [aws, kube], years: { required: 5, mine: 6, ok: true } },
    ...over,
  };
}

const props = (over: Partial<BreakdownPanelProps> = {}): BreakdownPanelProps => ({ jobId: 7, availability: "enabled", hasDescription: true, view: null, timeZone: "Europe/Berlin", ...over });
const state = () => screen.getByTestId("jd-breakdown-panel").getAttribute("data-state");

beforeEach(() => {
  breakdownJobAction.mockReset();
  breakdownStatusAction.mockReset();
  refresh.mockReset();
});

const queue = (over: Partial<ControlQueueView> = {}, worker: Partial<ControlQueueView["worker"]> = {}): ControlQueueView => ({
  ahead: 0,
  running: null,
  startedAt: null,
  now: "2026-10-28T12:00:00.000Z",
  ...over,
  worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 3, ...worker },
});

describe("BreakdownPanel states", () => {
  it("disabled: no button, a settings link", () => {
    render(wrap(<BreakdownPanel {...props({ availability: "disabled" })} />));
    expect(state()).toBe("disabled");
    expect(screen.queryByTestId("jd-breakdown-button")).toBeNull();
    expect(screen.getByTestId("jd-breakdown-settings-link")).toHaveAttribute("href", "/settings?tab=breakdown");
  });

  it("disabled with a stored result: shows the result read-only, without a re-run button", () => {
    render(wrap(<BreakdownPanel {...props({ availability: "disabled", view: view() })} />));
    expect(state()).toBe("done");
    expect(screen.getByTestId("jd-breakdown-readonly")).toHaveTextContent("read-only");
    expect(screen.queryByTestId("jd-breakdown-rerun")).toBeNull();
  });

  it("config error and no description", () => {
    const { unmount } = render(wrap(<BreakdownPanel {...props({ availability: "config_error" })} />));
    expect(state()).toBe("config_error");
    expect(screen.getByTestId("jd-breakdown-config-error")).toHaveTextContent("breakdown.yaml cannot be read");
    unmount();
    render(wrap(<BreakdownPanel {...props({ hasDescription: false })} />));
    expect(state()).toBe("no_description");
    expect(screen.queryByTestId("jd-breakdown-button")).toBeNull();
  });

  it("ready: the button queues a request, shows waiting, then refreshes when the request is done", async () => {
    breakdownJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 41 });
    breakdownStatusAction.mockResolvedValueOnce({ ok: true, state: "waiting", stage: "pending", queue: queue() }).mockResolvedValueOnce({ ok: true, state: "waiting", stage: "running", queue: queue() }).mockResolvedValue({ ok: true, state: "done" });
    render(wrap(<BreakdownPanel {...props()} />));
    expect(state()).toBe("ready");
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    expect(breakdownJobAction).toHaveBeenCalledWith({ jobId: 7, force: false });
    expect(state()).toBe("waiting");
    expect(screen.getByTestId("jd-breakdown-loading")).toHaveAttribute("data-stage", "pending");
    expect(screen.getByTestId("jd-breakdown-button")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("jd-breakdown-loading")).toHaveAttribute("data-stage", "running"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(breakdownStatusAction).toHaveBeenCalledWith({ jobId: 7, requestId: 41 });
  });

  it("resumes waiting from the server's unfinished request after a reload and polls it", async () => {
    breakdownStatusAction.mockResolvedValueOnce({ ok: true, state: "waiting", stage: "running", queue: queue() }).mockResolvedValue({ ok: true, state: "done" });
    render(wrap(<BreakdownPanel {...props({ initialRequest: { state: "waiting", requestId: 37, stage: "pending", queue: queue({ ahead: 1 }) } })} />));
    expect(state()).toBe("waiting");
    expect(screen.getByTestId("jd-breakdown-button")).toBeDisabled();
    await waitFor(() => expect(breakdownStatusAction).toHaveBeenCalledWith({ jobId: 7, requestId: 37 }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("starts in the failed state with a retry when the server's newest request failed", () => {
    render(wrap(<BreakdownPanel {...props({ initialRequest: { state: "failed", error: "timeout", detail: "codex-cli: timeout" } })} />));
    expect(state()).toBe("failed");
    expect(screen.getByRole("alert")).toHaveTextContent("did not answer in time");
    expect(screen.getByTestId("jd-breakdown-button")).toHaveTextContent("Retry");
  });

  it("an already current result just refreshes the page", async () => {
    breakdownJobAction.mockResolvedValue({ ok: true, queued: false });
    render(wrap(<BreakdownPanel {...props()} />));
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("failed: shows the reason with a detail, and the button retries", async () => {
    breakdownJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 5 });
    breakdownStatusAction.mockResolvedValueOnce({ ok: false, error: "timeout", detail: "codex-cli: timeout" });
    render(wrap(<BreakdownPanel {...props()} />));
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    await waitFor(() => expect(state()).toBe("failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("did not answer in time");
    expect(screen.getByTestId("jd-breakdown-error-detail")).toHaveTextContent("codex-cli: timeout");
    expect(screen.getByTestId("jd-breakdown-button")).toHaveTextContent("Retry");
  });

  it("a rejected action is a failure, a refused one shows its code", async () => {
    breakdownJobAction.mockRejectedValueOnce(new Error("network"));
    render(wrap(<BreakdownPanel {...props()} />));
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The breakdown failed"));
    breakdownJobAction.mockResolvedValueOnce({ ok: false, error: "disabled" });
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("turned off"));
  });

  it("waiting: how many requests are ahead and what the ai-worker is doing, with the start time", async () => {
    breakdownJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 5 });
    breakdownStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "pending", queue: queue({ ahead: 3, running: { kind: "score_jobs", since: "2026-10-28T11:05:00.000Z" } }) });
    render(wrap(<BreakdownPanel {...props()} />));
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    await waitFor(() => expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("3 requests ahead of it."));
    expect(screen.getByTestId("queue-hint-running")).toHaveTextContent("The ai-worker is working on “Score jobs”, started 12:05.");
    expect(state()).toBe("waiting");
  });

  it("running: its own start and how long it has been running", async () => {
    breakdownStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "running", queue: queue({ startedAt: "2026-10-28T10:30:00.000Z" }) });
    render(wrap(<BreakdownPanel {...props({ initialRequest: { state: "waiting", requestId: 37, stage: "running", queue: null } })} />));
    await waitFor(() => expect(screen.getByTestId("queue-hint-self")).toHaveTextContent("Running since 11:30, for 90 minutes."));
  });

  it("offline: no give-up; a line with the last heartbeat and a link to /sources, the state stays waiting while it polls", async () => {
    breakdownJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 5 });
    breakdownStatusAction.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: true, state: "waiting", stage: "pending", queue: queue({ ahead: 0 }, { online: false, heartbeatAgeSeconds: 7300 }) });
    render(wrap(<BreakdownPanel {...props()} />));
    await userEvent.click(screen.getByTestId("jd-breakdown-button"));
    await waitFor(() => expect(screen.getByTestId("queue-hint-offline")).toHaveTextContent("The ai-worker is offline (last heartbeat 2 h ago)."));
    expect(within(screen.getByTestId("queue-hint-offline")).getByRole("link")).toHaveAttribute("href", "/sources");
    expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("Next in line.");
    expect(state()).toBe("waiting");
    const calls = breakdownStatusAction.mock.calls.length;
    await waitFor(() => expect(breakdownStatusAction.mock.calls.length).toBeGreaterThan(calls + 2));
    expect(state()).toBe("waiting");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("outdated format and empty result offer a re-run", async () => {
    const { unmount } = render(wrap(<BreakdownPanel {...props({ view: view({ content: null }) })} />));
    expect(state()).toBe("outdated");
    expect(screen.getByTestId("jd-breakdown-outdated")).toHaveTextContent("older format");
    expect(screen.getByTestId("jd-breakdown-rerun")).toBeEnabled();
    unmount();
    const empty = view();
    render(wrap(<BreakdownPanel {...props({ view: { ...empty, content: { ...empty.content!, total: 0 } } })} />));
    expect(state()).toBe("empty");
    expect(screen.getByTestId("jd-breakdown-empty")).toHaveTextContent("found nothing");
  });
});

describe("BreakdownPanel result", () => {
  it("shows meta, groups, must / nice, the profile comparison and the footnote", () => {
    render(wrap(<BreakdownPanel {...props({ view: view() })} />));
    expect(state()).toBe("done");
    expect(screen.getByTestId("jd-breakdown-meta")).toHaveTextContent("codex-cli · gpt-5.5 · breakdown-v1");
    const groups = screen.getAllByTestId("jd-breakdown-tech-group");
    expect(groups.map((g) => g.getAttribute("data-category"))).toEqual(["languages", "cloud_infra"]);
    expect(within(groups[0]!).getByText("Languages")).toBeInTheDocument();
    const kube = within(groups[1]!).getByText("Kubernetes").closest("[data-requirement]");
    expect(kube).toHaveAttribute("data-requirement", "nice");
    expect(within(groups[1]!).getByText("nice")).toBeInTheDocument();
    expect(screen.getByTestId("jd-breakdown-match-counts")).toHaveTextContent("Must 1/2 · Nice 0/1");
    expect(within(screen.getByTestId("jd-breakdown-missing")).getByText("AWS")).toBeInTheDocument();
    expect(screen.getByTestId("jd-breakdown-years-match")).toHaveTextContent("≥ 5 years asked · you 6");
    expect(screen.getByTestId("jd-breakdown-years-match")).toHaveAttribute("data-ok", "true");
    expect(screen.getByTestId("jd-breakdown-years")).toHaveTextContent("At least 5 years");
    expect(screen.getByText(/AI breakdown, for reference only/)).toBeInTheDocument();
  });

  it("tech chips use hit / miss badges by the profile; without profile skills they are neutral and link to /me", () => {
    const { unmount } = render(wrap(<BreakdownPanel {...props({ view: view() })} />));
    const tech = screen.getByTestId("jd-breakdown-tech");
    expect(within(tech).getByText("Python").closest("[data-have]")).toHaveAttribute("data-have", "true");
    expect(within(tech).getByText("AWS").closest("[data-have]")).toHaveAttribute("data-have", "false");
    unmount();
    const v = view();
    const flat = { ...v, match: { state: "none" as const }, content: { ...v.content!, techGroups: v.content!.techGroups.map((g) => ({ ...g, items: g.items.map((t) => ({ ...t, have: null })) })) } };
    render(wrap(<BreakdownPanel {...props({ view: flat })} />));
    expect(screen.getByTestId("jd-breakdown-match-none")).toBeInTheDocument();
    expect(within(screen.getByTestId("jd-breakdown-match-none")).getByRole("link")).toHaveAttribute("href", "/me");
    expect(screen.getByTestId("jd-breakdown-tech").querySelector("[data-have]")).toBeNull();
  });

  it("a jump button exists only for a quote with a highlight; the others show the quote as a tooltip", async () => {
    const jumps: number[] = [];
    window.addEventListener(JD_JUMP_EVENT, (event) => jumps.push((event as CustomEvent<{ index: number }>).detail.index));
    render(wrap(<BreakdownPanel {...props({ view: view() })} />));
    const python = within(screen.getByTestId("jd-breakdown-tech")).getByText("Python").closest("button");
    expect(python).toHaveAttribute("title", "Show in the JD: Our stack: Python and Kubernetes");
    await userEvent.click(python!);
    expect(jumps).toEqual([0]);
    // AWS has no highlight: no button around it, the quote is its title
    const aws = within(screen.getByTestId("jd-breakdown-tech")).getByText("AWS").closest("[title]");
    expect(aws).toHaveAttribute("title", "Our stack: Python and Kubernetes");
    expect(within(screen.getByTestId("jd-breakdown-tech")).getByText("AWS").closest("button")).toBeNull();
    const responsibilities = screen.getByTestId("jd-breakdown-responsibilities");
    expect(within(responsibilities).getAllByRole("button")).toHaveLength(1);
    expect(within(responsibilities).getByTitle("Write docs.")).toBeInTheDocument();
  });

  it("marks must with a solid and nice with a dashed tag", () => {
    render(wrap(<BreakdownPanel {...props({ view: view() })} />));
    const soft = screen.getByTestId("jd-breakdown-softSkills");
    expect(within(soft).getByText("Nice")).toHaveAttribute("data-requirement", "nice");
    expect(within(soft).getByText("Nice").className).toContain("border-dashed");
    const exp = screen.getByTestId("jd-breakdown-experience");
    expect(within(exp).getByText("Must").className).not.toContain("border-dashed");
  });

  it("flags a changed JD and an old prompt, offers a forced re-run, and the dropped count shows in the meta line", async () => {
    breakdownJobAction.mockResolvedValue({ ok: true, queued: true, requestId: 3 });
    const v = view({ stale: { jd: true, prompt: true, lang: true }, meta: { ...view().meta, dropped: 2 } });
    render(wrap(<BreakdownPanel {...props({ view: v })} />));
    expect(screen.getByTestId("jd-breakdown-stale-jd")).toHaveTextContent("The JD changed since");
    expect(screen.getByTestId("jd-breakdown-stale-prompt")).toHaveTextContent("older prompt");
    expect(screen.getByTestId("jd-breakdown-stale-lang")).toHaveTextContent("The AI language changed since");
    expect(screen.getByTestId("jd-breakdown-meta")).toHaveTextContent("2 dropped");
    await userEvent.click(screen.getByTestId("jd-breakdown-rerun"));
    expect(breakdownJobAction).toHaveBeenCalledWith({ jobId: 7, force: true });
    expect(state()).toBe("waiting");
    // the old result stays visible while the new one is made
    expect(screen.getByTestId("jd-breakdown-result")).toBeInTheDocument();
  });

  it("is shown in Chinese for a zh interface", () => {
    render(wrap(<BreakdownPanel {...props({ view: view() })} />, "zh"));
    expect(screen.getByText("编程语言")).toBeInTheDocument();
    expect(screen.getByTestId("jd-breakdown-match-counts")).toHaveTextContent("必须 1/2 · 加分 0/1");
    act(() => {});
  });
});
