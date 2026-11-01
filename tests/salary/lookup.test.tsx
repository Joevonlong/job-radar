import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SalaryPanel } from "@/components/jobs/detail/salary-panel";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { salaryLookupResultSchema } from "@/lib/salary/lookup-types";
import type { SalaryContext, SalaryLookupView } from "@/lib/salary/view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const { lookupSalaryAction, salaryLookupStatusAction, refresh } = vi.hoisted(() => ({ lookupSalaryAction: vi.fn(), salaryLookupStatusAction: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/jobs/[id]/salary-actions", () => ({ lookupSalaryAction, salaryLookupStatusAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/settings/constants", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settings/constants")>()), STATUS_POLL_MS: 10 }));

const queue = (over: Partial<ControlQueueView> = {}, worker: Partial<ControlQueueView["worker"]> = {}): ControlQueueView => ({
  ahead: 0,
  running: null,
  startedAt: null,
  now: "2026-10-28T12:00:00.000Z",
  ...over,
  worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 3, ...worker },
});

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

type LookupOver = Partial<SalaryContext["lookup"]> & { groupQuantiles?: number[] | null };

/** The panel around a lookup state: the posting states no salary, no group, no company salaries. */
function Panel({ over = {}, base = {} }: { over?: LookupOver; base?: Partial<SalaryContext> }) {
  const { groupQuantiles, ...lookupOver } = over;
  const context: SalaryContext = {
    state: "ok", currency: "EUR", familyId: "software", familyLabel: "Software", figure: null,
    group: groupQuantiles ? { level: "family", seniority: null, place: null, n: 5, median: groupQuantiles[Math.floor(groupQuantiles.length / 2)] ?? 0, quantiles: groupQuantiles } : null,
    position: null, company: { count: 0, median: null, minSample: 3, figures: [] }, links: [],
    staleAi: false, benchmarkEnabled: true, benchmarkComputed: true,
    lookup: { availability: "enabled", unrestricted: false, providers: ["claude-cli", "anthropic"], latest: null, initialRequest: null, usedToday: 0, maxPerDay: 3, ttlDays: 30, ...lookupOver },
    ...base,
  };
  return <SalaryPanel context={context} salary={null} salaryDisclosed={false} normalizedText={null} floor={null} axis={{ minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" }} jobId={7} company="Acme" timeZone="Europe/Berlin" />;
}
const panel = (over: LookupOver = {}, base: Partial<SalaryContext> = {}) => <Panel over={over} base={base} />;

function lookup(over: Partial<SalaryLookupView> = {}): SalaryLookupView {
  const band = {
    title: "Software Engineer", seniority: "senior", location: "Example City", basis: "base",
    min: 80000, max: 100000, median: 90000, convertible: true,
    original: { min: 80000, max: 100000, median: 90000, currency: "EUR" }, sources: [0],
  };
  return {
    id: 1, origin: { jobId: 7, title: band.title }, provider: "seed", model: "seed",
    fetchedAt: "2026-01-01T12:00:00.000Z", expired: false,
    result: salaryLookupResultSchema.parse({
      query: { company: "Acme", title: band.title, seniority: "senior", city: "Example City", country: "DE", currency: "EUR" },
      companyLevel: { level: "market", median: 90000, summary: "Fictional salary estimate", sources: [0] },
      roleBand: band,
      relatedRoles: [{ ...band, title: "Platform Engineer" }, { ...band, title: "Backend Engineer" }],
      sources: [
        { url: "https://salary.example.org/roles", host: "salary.example.org", site: "Salary site", title: "Salary estimates", excerpt: "Example salaries", trusted: true },
        { url: "https://blog.example.org/pay", host: "blog.example.org", site: "Blog", title: "Pay estimates", excerpt: "Example pay", trusted: false },
      ],
      confidence: "medium", notes: "Fictional lookup", dropped: 0, observations: [],
    }),
    ...over,
  };
}

beforeEach(() => {
  lookupSalaryAction.mockReset();
  salaryLookupStatusAction.mockReset();
  refresh.mockReset();
});

describe("salary lookup in the panel", () => {
  it.each(["unreadable", "invalid queue"])("retries an %s status and keeps the last queue until completion", async (reason) => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    salaryLookupStatusAction
      .mockResolvedValueOnce(reason === "unreadable" ? null : { ok: true, state: "waiting", stage: "pending", queue: queue({ ahead: -1 }) })
      .mockImplementation(async () => {
        await released;
        return { ok: true, state: "done" };
      });
    render(wrap(panel({ initialRequest: { state: "waiting", requestId: 12, stage: "pending", queue: queue({ ahead: 2 }) } })));
    await waitFor(() => expect(salaryLookupStatusAction).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("2 requests ahead of it.");
    expect(screen.getByTestId("salary-panel")).toHaveAttribute("data-lookup-state", "waiting");
    expect(screen.queryByTestId("salary-lookup-error")).toBeNull();
    release();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(salaryLookupStatusAction).toHaveBeenCalledTimes(2);
  });

  it("counts a queued lookup at once, without a reload", async () => {
    lookupSalaryAction.mockResolvedValue({ ok: true, queued: true, requestId: 11, usedToday: 1 });
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "pending", queue: queue() });
    render(wrap(panel()));
    expect(screen.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used", "0");
    await userEvent.click(screen.getByTestId("salary-lookup-button"));
    await waitFor(() => expect(screen.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used", "1"));
  });

  it("waiting: how many requests are ahead and what the ai-worker is doing, with the start time", async () => {
    lookupSalaryAction.mockResolvedValue({ ok: true, queued: true, requestId: 11, usedToday: 1 });
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "pending", queue: queue({ ahead: 1, running: { kind: "translate_job", since: "2026-10-28T11:58:00.000Z" } }) });
    render(wrap(panel()));
    await userEvent.click(screen.getByTestId("salary-lookup-button"));
    await waitFor(() => expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("1 request ahead of it."));
    expect(screen.getByTestId("queue-hint-running")).toHaveTextContent("The ai-worker is working on “Translation”, started 12:58.");
    expect(screen.getByTestId("salary-panel")).toHaveAttribute("data-lookup-state", "waiting");
  });

  it("a refresh over a shown result: the queue lines show under the result while it runs", async () => {
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "running", queue: queue({ startedAt: "2026-10-28T11:57:00.000Z" }) });
    render(wrap(panel({ latest: lookup(), initialRequest: { state: "waiting", requestId: 12, stage: "running", queue: null } })));
    await waitFor(() => expect(screen.getByTestId("queue-hint-self")).toHaveTextContent("Running since 12:57, for 3 minutes."));
  });

  it("offline: a line with the last heartbeat and a link to /sources; the card stays waiting and keeps polling", async () => {
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "pending", queue: queue({}, { online: false, heartbeatAgeSeconds: 600 }) });
    render(wrap(panel({ initialRequest: { state: "waiting", requestId: 12, stage: "pending", queue: queue({}, { online: false, heartbeatAgeSeconds: 600 }) } }), "zh"));
    expect(screen.getByTestId("queue-hint-offline")).toHaveTextContent("ai-worker 离线（最后心跳在 10 分钟前）");
    expect(within(screen.getByTestId("queue-hint-offline")).getByRole("link")).toHaveAttribute("href", "/sources");
    await waitFor(() => expect(salaryLookupStatusAction.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByTestId("salary-panel")).toHaveAttribute("data-lookup-state", "waiting");
    expect(screen.queryByTestId("salary-lookup-error")).toBeNull();
  });

  it("with the daily limit used up the button is disabled, says why and offers no retry", () => {
    render(wrap(panel({ usedToday: 3, initialRequest: { state: "failed", error: "auth", detail: null } })));
    const button = screen.getByTestId("salary-lookup-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-blocked", "quota");
    expect(button).not.toHaveTextContent("Try again");
    expect(screen.getByTestId("salary-lookup-quota")).toHaveAttribute("data-used-up", "true");
    expect(screen.getByTestId("salary-lookup-quota")).toHaveTextContent("All 3 lookups of the last 24 hours are used");
  });

  it("a login failure names the logins of the providers the lookup can use, and only those", () => {
    render(wrap(panel({ usedToday: 1, initialRequest: { state: "failed", error: "auth", detail: null } })));
    const error = screen.getByTestId("salary-lookup-error");
    expect(error).toHaveTextContent("claude-cli, anthropic");
    expect(error).toHaveTextContent("claude → /login");
    expect(error).toHaveTextContent("ANTHROPIC_API_KEY");
    expect(error).not.toHaveTextContent("codex");
    expect(screen.getByTestId("salary-lookup-button")).toHaveTextContent("Try again");
  });
});

describe.each(["en", "zh"] as const)("salary lookup trust labels (%s)", (locale) => {
  const text = locale === "en" ? en.salary.lookup : zh.salary.lookup;

  it("labels the AI's confidence, every estimate and its sources, and explains the shared scope", () => {
    render(wrap(panel({ latest: lookup() }), locale));
    const card = screen.getByTestId("salary-panel");
    expect(screen.getByTestId("salary-lookup-ai-badge")).toHaveTextContent(locale === "en" ? "AI lookup" : "AI 查询");
    const mark = locale === "en" ? "AI estimate (unverified)" : "AI 估计（未核对）";
    for (const id of ["salary-lookup-role", "salary-lookup-related-0", "salary-lookup-related-1", "salary-lookup-company"]) {
      expect(screen.getByTestId(`${id}-unverified`)).toHaveTextContent(mark);
    }
    expect(screen.getByTestId("salary-lookup-confidence")).toHaveTextContent(locale === "en" ? "AI's own confidence" : "AI 自评置信度");
    expect(screen.getByRole("heading", { name: locale === "en" ? "Sources given by the AI (unverified)" : "AI 给出的来源（未核对）" })).toBeVisible();
    expect(screen.getByTestId("salary-lookup-other-source")).toHaveTextContent(locale === "en" ? "not on your salary-site list" : "不在薪资网站列表中");
    expect(screen.getByTestId("salary-lookup-disclaimer")).toHaveTextContent(text.disclaimer);
    expect(screen.getByTestId("salary-lookup-scope")).toHaveTextContent(locale === "en" ? "It is not based on this job description." : "不是根据这条 JD。");
    expect(card).not.toHaveTextContent(/已核对|已验证|\bverified\b/i);
  });

  it("does not show an origin note for a lookup made on this posting", () => {
    render(wrap(panel({ latest: lookup() }), locale));
    expect(screen.queryByTestId("salary-lookup-origin")).not.toBeInTheDocument();
    expect(screen.getByTestId("salary-lookup-scope")).toBeVisible();
  });

  it("links to the title of the other posting that started the lookup", () => {
    const origin = { jobId: 9, title: "Senior Software Engineer" };
    render(wrap(panel({ latest: lookup({ origin }) }), locale));
    const note = screen.getByTestId("salary-lookup-origin");
    expect(note).toHaveTextContent(text.origin.replace("<link>{title}</link>", origin.title));
    expect(within(note).getByRole("link", { name: origin.title })).toHaveAttribute("href", "/jobs/9");
  });

  it("explains when the posting that started the lookup has been deleted", () => {
    render(wrap(panel({ latest: lookup({ origin: null }) }), locale));
    const note = screen.getByTestId("salary-lookup-origin");
    expect(note).toHaveTextContent(locale === "en" ? "The posting this lookup was made on has been deleted." : "发起这次查询的岗位已删除。");
    expect(within(note).queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders old lookup rows with non-empty observations as unverified estimates", () => {
    const latest = lookup();
    latest.result = salaryLookupResultSchema.parse({
      ...latest.result,
      observations: [{ family: "software", seniority: "senior", city: "Example City", country: "DE", figure: 90000 }],
    });
    expect(latest.result.observations).toHaveLength(1);
    render(wrap(panel({ latest }), locale));
    expect(screen.getByTestId("salary-lookup-role")).toHaveTextContent("Software Engineer");
    expect(screen.getByTestId("salary-lookup-role-unverified")).toBeVisible();
    expect(screen.getByTestId("salary-panel")).not.toHaveTextContent(/已核对|已验证|\bverified\b/i);
  });
});

describe("one live region and one alert in the panel", () => {
  const liveRegions = () => ({ status: screen.queryAllByRole("status").length, alert: screen.queryAllByRole("alert").length });

  it("a lookup without a result: the waiting line and the queue lines share the one status region", async () => {
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "pending", queue: queue({ ahead: 1 }) });
    render(wrap(panel({ initialRequest: { state: "waiting", requestId: 12, stage: "pending", queue: queue({ ahead: 1 }) } })));
    const region = screen.getByRole("status");
    expect(within(region).getByTestId("salary-lookup-loading")).toBeVisible();
    expect(within(region).getByTestId("queue-hint-ahead")).toHaveTextContent("1 request ahead of it.");
    expect(liveRegions()).toEqual({ status: 1, alert: 0 });
    // the head cell only says it in plain words
    expect(within(screen.getByTestId("salary-head-ai")).queryByRole("status")).toBeNull();
    expect(screen.getByTestId("salary-head-ai")).toHaveTextContent("Looking up…");
  });

  it("a refresh over a result: still one status region", async () => {
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "waiting", stage: "running", queue: queue({ startedAt: "2026-10-28T11:57:00.000Z" }) });
    render(wrap(panel({ latest: lookup(), initialRequest: { state: "waiting", requestId: 12, stage: "running", queue: null } })));
    await waitFor(() => expect(screen.getByTestId("queue-hint-self")).toBeVisible());
    expect(liveRegions()).toEqual({ status: 1, alert: 0 });
    expect(screen.getByTestId("salary-lookup-result")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("salary-lane-ai")).toHaveAttribute("data-state", "drawn");
  });

  it("shows the unrestricted line when the provider searches without a domain limit", () => {
    render(wrap(panel({ unrestricted: true })));
    expect(screen.getByTestId("salary-lookup-unrestricted")).toHaveTextContent("codex-cli searches the web without a domain limit.");
    cleanup();
    render(wrap(panel({ unrestricted: false })));
    expect(screen.queryByTestId("salary-lookup-unrestricted")).toBeNull();
  });

  it("the usage cap failure says when the AI works again, or that it continues by itself", () => {
    render(wrap(panel({ usedToday: 1, initialRequest: { state: "failed", error: "quota_guard", detail: null, resumeAt: "2026-10-28T13:30:00.000Z" } })));
    expect(screen.getByTestId("salary-lookup-error")).toHaveAttribute("data-error", "quota_guard");
    expect(screen.getByTestId("salary-lookup-error")).toHaveTextContent("Job Radar's own AI usage cap is reached");
    expect(screen.getByTestId("salary-lookup-error")).toHaveTextContent("Available again after 14:30.");
    cleanup();
    render(wrap(panel({ usedToday: 1, initialRequest: { state: "failed", error: "quota_guard", detail: null, resumeAt: null } })));
    expect(screen.getByTestId("salary-lookup-error")).toHaveTextContent("It continues by itself later.");
  });

  it("a finished request shows the done toast and refreshes the page once", async () => {
    salaryLookupStatusAction.mockResolvedValue({ ok: true, state: "done" });
    render(wrap(panel({ initialRequest: { state: "waiting", requestId: 12, stage: "pending", queue: null } })));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Salary lookup finished", expect.anything());
  });

  it("a failed request newer than the stored result is still reported when the lookup is off", () => {
    render(wrap(panel({ availability: "disabled", latest: lookup(), initialRequest: { state: "failed", error: "no_handler", detail: null, resumeAt: null } })));
    expect(screen.getByTestId("salary-lookup-error")).toHaveAttribute("data-error", "no_handler");
    expect(screen.getByTestId("salary-lookup-disabled")).toBeVisible();
    expect(screen.queryByTestId("salary-lookup-refresh")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    expect(screen.getByTestId("salary-lookup-result")).toBeVisible();
  });

  it("a failure is the only alert", () => {
    render(wrap(panel({ usedToday: 1, initialRequest: { state: "failed", error: "auth", detail: null } })));
    expect(liveRegions()).toEqual({ status: 1, alert: 1 });
    expect(within(screen.getByRole("status")).queryByTestId("queue-hint")).toBeNull();
  });
});

describe("a stored result when the lookup cannot run any more", () => {
  it.each([
    ["disabled", "salary-lookup-disabled", "The salary lookup is off"],
    ["no_web_provider", "salary-lookup-no-provider", "None of the AI providers"],
    ["config_error", "salary-lookup-config-error", "cannot be read"],
    ["not_ready", "salary-lookup-not-ready", "do not exist yet"],
  ] as const)("%s: the result stays, the button and quota go, the reason and its link show", (availability, testId, text) => {
    render(wrap(panel({ availability, latest: lookup() })));
    expect(screen.getByTestId("salary-lookup-result")).toBeVisible();
    expect(screen.getByTestId("salary-lane-ai")).toHaveAttribute("data-state", "drawn");
    expect(screen.queryByTestId("salary-lookup-refresh")).toBeNull();
    expect(screen.queryByTestId("salary-lookup-button")).toBeNull();
    expect(screen.queryByTestId("salary-lookup-quota")).toBeNull();
    expect(screen.getByTestId(testId)).toHaveTextContent(text);
    expect(screen.getByTestId("salary-panel")).toHaveAttribute("data-lookup-state", "done");
  });

  it("without a stored result the same reason shows and the cell says why", () => {
    render(wrap(panel({ availability: "disabled" })));
    expect(screen.getByTestId("salary-lookup-settings-link")).toHaveAttribute("href", "/settings?tab=salary");
    expect(screen.getByTestId("salary-head-ai")).toHaveTextContent("Lookup is off");
    expect(screen.getByTestId("salary-lane-ai")).toHaveAttribute("data-state", "disabled");
  });
});

describe("the AI row only draws this role's band", () => {
  const noBand = () => lookup({ result: { ...lookup().result, roleBand: null, companyLevel: { level: "above", median: 150000, summary: "", sources: [0] } } });

  it("without a role band the company-wide median is neither on the ruler nor in the role's cell", () => {
    render(wrap(panel({ latest: noBand() })));
    const row = screen.getByTestId("salary-lane-ai");
    expect(row).toHaveAttribute("data-state", "no_band");
    expect(row).toHaveTextContent("No range found for this role");
    expect(row.querySelector("[data-mark]")).toBeNull();
    expect(row.querySelector('[data-testid="salary-lane-ai-block"]')).toBeNull();
    expect(row).not.toHaveTextContent("150k");
    const head = screen.getByTestId("salary-head-ai");
    expect(head).toHaveTextContent("No range found for this role");
    expect(head).toHaveTextContent("Company overall: Above the market · Company-wide median €150k");
    expect(screen.queryByTestId("salary-head-ai-figure")).toBeNull();
  });

  it("a band in total pay is drawn with another fill and says it cannot be compared with base salary", () => {
    const latest = lookup();
    latest.result = { ...latest.result, roleBand: { ...latest.result.roleBand!, basis: "total" } };
    render(wrap(panel({ latest, groupQuantiles: [60000, 70000, 80000, 85000, 90000, 95000, 100000, 110000, 120000] })));
    const row = screen.getByTestId("salary-lane-ai");
    expect(screen.getByTestId("salary-lane-ai-block")).toHaveAttribute("data-tone", "ai-total");
    expect(screen.getByTestId("salary-lane-ai-source")).toHaveTextContent("total pay, not comparable with base salary");
    expect(row).toHaveTextContent("€80–100k, median €90k");
    // no percentile against the group's base salaries in the row; the details do not compute one either
    expect(screen.queryByTestId("salary-lookup-role-percentile")).toBeNull();
  });

  it.each([
    ["total", "total pay (with bonus or equity)"],
    ["unknown", "basis not stated"],
  ] as const)("a %s band is tagged under the figure in the top cell, so it is not read as base salary", (basis, text) => {
    const latest = lookup();
    latest.result = { ...latest.result, roleBand: { ...latest.result.roleBand!, basis } };
    render(wrap(panel({ latest })));
    const tag = screen.getByTestId("salary-head-ai-basis");
    expect(tag).toHaveTextContent(text);
    expect(tag).toHaveAttribute("data-basis", basis);
    expect(screen.getByTestId("salary-head-ai")).toHaveTextContent("€80–100k");
  });

  it("a base-salary band has no basis tag in the top cell", () => {
    render(wrap(panel({ latest: lookup() })));
    expect(screen.getByTestId("salary-head-ai-figure")).toBeVisible();
    expect(screen.queryByTestId("salary-head-ai-basis")).toBeNull();
  });

  it("the source sentence says when the result is expired, comes from another posting or has no stated basis", () => {
    const latest = lookup({ expired: true, origin: { jobId: 99, title: "Other role" } });
    latest.result = { ...latest.result, roleBand: { ...latest.result.roleBand!, basis: "unknown" } };
    render(wrap(panel({ latest })));
    expect(screen.getByTestId("salary-lane-ai-source")).toHaveTextContent("AI web search · unverified · basis not stated · expired · looked up on another posting");
  });

  it("a base-salary band is hatched, marked unverified and positioned in the group in the details", () => {
    render(wrap(panel({ latest: lookup(), groupQuantiles: [60000, 70000, 80000, 85000, 90000, 95000, 100000, 110000, 120000] })));
    expect(screen.getByTestId("salary-lane-ai-block")).toHaveAttribute("data-tone", "ai");
    expect(screen.getByTestId("salary-lane-ai-source")).toHaveTextContent("AI web search · unverified");
    expect(screen.getByTestId("salary-head-ai")).toHaveTextContent("unverified");
    expect(screen.getByTestId("salary-lookup-role-percentile")).toBeVisible();
  });

  it("a band in another currency is written as text and not drawn", () => {
    const latest = lookup();
    latest.result = { ...latest.result, roleBand: { ...latest.result.roleBand!, convertible: false, min: null, max: null, median: null, original: { min: 90000, max: 110000, median: null, currency: "USD" } } };
    render(wrap(panel({ latest })));
    const row = screen.getByTestId("salary-lane-ai");
    expect(row).toHaveAttribute("data-state", "not_convertible");
    expect(row).toHaveTextContent("$90–110k");
    expect(row).toHaveTextContent("Stated in USD");
    expect(row.querySelector('[data-testid="salary-lane-ai-block"]')).toBeNull();
  });
});
