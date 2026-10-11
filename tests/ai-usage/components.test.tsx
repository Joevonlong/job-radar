import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CallLog } from "@/components/ai-usage/call-log";
import { KpiTiles } from "@/components/ai-usage/kpi-tiles";
import { RangePicker } from "@/components/ai-usage/range-picker";
import { ModelName, Tokens, Unknown, Usd } from "@/components/ai-usage/usage-cells";
import type { AiUsageUrlState } from "@/lib/ai-usage/params";
import type { AiUsageTotals } from "@/lib/ai-usage/view";
import type { AiUsageCall } from "@/lib/db/queries/ai-usage";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }) }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

const state: AiUsageUrlState = { range: "30d", from: null, to: null, provider: null, model: null, task: null, metric: null, page: null };
const totals: AiUsageTotals = {
  calls: 8, ok: 5, invalid: 1, failed: 1, legacy: 1, tokenCalls: 6, tokenUnknownCalls: 2, tokensIn: 13400, tokensInCached: 1500, tokensInCacheWrite: 0, tokensOut: 2450, tokensOutReasoning: 50,
  cachedUnknownCalls: 0, reasoningUnknownCalls: 0, equivalentUnknownModelCalls: 0,
  equivalentUsd: 0.02866, equivalentUnknownCalls: 3, actualUsd: 0.00156, actualUnknownCalls: 0, savingsUsd: 0.0271, avgDurationMs: 1000,
};

describe("usage cells", () => {
  it("Unknown says unknown, never 0", () => {
    render(wrap(<Unknown />));
    expect(screen.getByText("Unknown")).toHaveAttribute("data-unknown");
  });
  it("Tokens: an unknown main number makes the whole cell unknown; an unknown part is a dash", () => {
    const { container, rerender } = render(wrap(<Tokens main={null} part={5} />));
    expect(container.querySelector("[data-unknown]")).not.toBeNull();
    rerender(wrap(<Tokens main={1800} part={null} />));
    expect(container).toHaveTextContent("1,800 / —");
    rerender(wrap(<Tokens main={1800} part={500} />));
    expect(container).toHaveTextContent("1,800 / 500");
  });
  it("Tokens: a sub-count missing from some calls shows the known sum and how many are unknown; from all calls it is unknown, not 0", () => {
    const { container, rerender } = render(wrap(<Tokens main={832711} part={11520} partUnknown={2} partTotal={5} />));
    expect(container).toHaveTextContent("832,711 / 11,520 · 2 unknown");
    rerender(wrap(<Tokens main={829692} part={0} partUnknown={5} partTotal={5} />));
    expect(container).toHaveTextContent("829,692 / Unknown");
    expect(container).not.toHaveTextContent("/ 0");
  });
  it("Usd: null is unknown, small amounts keep four decimals", () => {
    const { container, rerender } = render(wrap(<Usd value={null} />));
    expect(container.querySelector("[data-unknown]")).not.toBeNull();
    rerender(wrap(<Usd value={0.00786} />));
    expect(container).toHaveTextContent("$0.0079");
    rerender(wrap(<Usd value={0} />));
    expect(container).toHaveTextContent("$0.00");
  });
  it("ModelName: tags for the CLI default and an assumed model, a dashed tag for no model", () => {
    const { rerender } = render(wrap(<ModelName provider="codex-cli" model="gpt-6.1-sol" label="GPT-6.1 Sol" source="cli_default" />));
    expect(screen.getByText("CLI default")).toBeInTheDocument();
    expect(screen.getByText("gpt-6.1-sol")).toBeInTheDocument();
    rerender(wrap(<ModelName provider="claude-cli" model="claude-haiku-4-5" label={null} source="assumed" />));
    expect(screen.getByText("Assumed")).toBeInTheDocument();
    rerender(wrap(<ModelName provider="claude-cli" model={null} label={null} source={null} />));
    expect(screen.getByText("Unknown model")).toHaveAttribute("data-unknown");
  });
});

describe("KpiTiles", () => {
  it("shows the seeded figures and the footnotes for what was left out", () => {
    render(wrap(<KpiTiles totals={totals} />));
    expect(screen.getByTestId("ai-kpi-equivalent")).toHaveTextContent("$0.0287");
    expect(screen.getByTestId("ai-kpi-actual")).toHaveTextContent("$0.0016");
    expect(screen.getByTestId("ai-kpi-savings")).toHaveTextContent("$0.0271");
    expect(screen.getByTestId("ai-kpi-calls")).toHaveAttribute("data-value", "8");
    expect(screen.getByTestId("ai-kpi-tokens")).toHaveTextContent("15,850");
    expect(screen.getByTestId("ai-kpi-unknown-tokens")).toHaveAttribute("data-count", "2");
    expect(screen.getByTestId("ai-kpi-missing-equivalent")).toHaveAttribute("data-count", "3");
  });
  it.each([["en", "1.95M", "$1.95M"], ["zh", "195.33万", "$195.33万"]] as const)("writes 7+ digit figures compact so they cannot overflow the card, exact value in the title (%s)", (locale, compactTokens, compactUsd) => {
    const big: AiUsageTotals = { ...totals, calls: 1_234_567, tokensIn: 1_900_000, tokensOut: 53_326, tokenCalls: 6, tokenUnknownCalls: 0, equivalentUsd: 1_953_326.5, equivalentUnknownCalls: 0, actualUsd: 2_500_000, actualUnknownCalls: 0, savingsUsd: 1_234.5 };
    render(wrap(<KpiTiles totals={big} />, locale));
    const tokens = screen.getByTestId("ai-kpi-tokens");
    expect(within(tokens).getByTitle("1,953,326")).toHaveTextContent(compactTokens);
    expect(within(screen.getByTestId("ai-kpi-calls")).getByTitle("1,234,567")).toHaveAttribute("data-compact", "true");
    expect(within(screen.getByTestId("ai-kpi-equivalent")).getByTitle("$1,953,326.50")).toHaveTextContent(compactUsd);
    expect(screen.getByTestId("ai-kpi-savings")).toHaveTextContent("$1,234.50");
    expect(tokens).toHaveAttribute("data-value", "1953326");
  });
  it("says unknown instead of 0 for the cached / reasoning split of old rows, and tells an unknown model from a missing price", () => {
    render(wrap(<KpiTiles totals={{ ...totals, cachedUnknownCalls: 6, reasoningUnknownCalls: 2, equivalentUnknownModelCalls: 1 }} />));
    const tokens = screen.getByTestId("ai-kpi-tokens");
    expect(tokens).toHaveTextContent("cached unknown");
    expect(tokens).toHaveTextContent("reasoning 50, plus 2 unknown");
    expect(screen.getByTestId("ai-kpi-missing-equivalent")).toHaveAttribute("data-count", "2");
    expect(screen.getByTestId("ai-kpi-unknown-model")).toHaveAttribute("data-count", "1");
    // English plural: "1 call", "2 calls", never "1 calls"
    expect(screen.getByTestId("ai-kpi-unknown-model")).toHaveTextContent("(1 call)");
    expect(screen.getByTestId("ai-kpi-missing-equivalent")).toHaveTextContent("(2 calls)");
    expect(screen.getByTestId("ai-kpi-unknown-tokens")).toHaveTextContent("2 calls have no token counts");
  });
  it("uses the singular for a single call without counts", () => {
    render(wrap(<KpiTiles totals={{ ...totals, tokenUnknownCalls: 1 }} />));
    expect(screen.getByTestId("ai-kpi-unknown-tokens")).toHaveTextContent("1 call has no token counts");
  });
  it("has no footnotes when nothing was left out", () => {
    render(wrap(<KpiTiles totals={{ ...totals, tokenUnknownCalls: 0, equivalentUnknownCalls: 0 }} />));
    expect(screen.queryByTestId("ai-kpi-unknown-tokens")).toBeNull();
    expect(screen.queryByTestId("ai-kpi-missing-equivalent")).toBeNull();
  });
  it("shows unknown, not 0, when no call has token counts or an equivalent cost", () => {
    render(wrap(<KpiTiles totals={{ ...totals, tokenCalls: 0, tokenUnknownCalls: 8, equivalentUnknownCalls: 8 }} />));
    for (const id of ["ai-kpi-equivalent", "ai-kpi-savings", "ai-kpi-tokens"]) {
      expect(within(screen.getByTestId(id)).getByText("Unknown")).toBeInTheDocument();
    }
  });
});

const call = (over: Partial<AiUsageCall>): AiUsageCall => ({
  id: 1, at: new Date("2026-10-07T12:03:12Z"), provider: "codex-cli", model: "gpt-6.1-sol", modelSource: "cli_default", task: "translate", outcome: "ok", errorKind: null,
  tokensIn: 3000, tokensInCached: 1000, tokensInCacheWrite: 0, tokensOut: 200, tokensOutReasoning: 50, durationMs: 8200, costUsd: 0, equivalentUsd: 0.0061, job: null, ...over,
});

describe("CallLog", () => {
  const log = (calls: AiUsageCall[], locale: "en" | "zh" = "en") =>
    render(wrap(<CallLog calls={calls} total={calls.length} page={1} pageSize={50} timeZone="Europe/Berlin" state={state} exportHref="/sources/ai-usage/export?range=30d" csvMaxRows={20000} modelLabels={{}} />, locale));

  it("renders the three outcomes and the legacy row", () => {
    log([
      call({ id: 1 }),
      call({ id: 2, outcome: "invalid_output" }),
      call({ id: 3, outcome: "failed", errorKind: "timeout", tokensIn: null, tokensOut: null, equivalentUsd: null }),
      call({ id: 4, outcome: null, model: null, modelSource: null, durationMs: null }),
    ]);
    const rows = screen.getAllByTestId("ai-call-row");
    expect(rows.map((r) => r.getAttribute("data-outcome"))).toEqual(["ok", "invalid_output", "failed", "legacy"]);
    expect(rows[0]).toHaveTextContent("10-07 14:03:12");
    expect(rows[0]).toHaveTextContent("8.2 s");
    expect(rows[1]).toHaveTextContent("Invalid output, retried");
    expect(rows[2]).toHaveTextContent("Timed out");
    expect(within(rows[2] as HTMLElement).getByTestId("ai-call-input").querySelector("[data-unknown]")).not.toBeNull();
    expect(rows[3]).toHaveTextContent("Unknown model");
  });
  it("links a job and shows a dash without one", () => {
    log([call({ id: 1, job: { id: 9, title: "Forward Deployed Engineer", company: "X" } }), call({ id: 2 })]);
    expect(screen.getByTestId("ai-call-job")).toHaveAttribute("href", "/jobs/9");
  });
  it("offers the export and the range text, in Chinese too", () => {
    log([call({ id: 1 })], "zh");
    expect(screen.getByTestId("ai-usage-export")).toHaveAttribute("href", "/sources/ai-usage/export?range=30d");
    expect(screen.getByTestId("ai-call-range")).toHaveTextContent("第 1–1 条，共 1 条");
  });
});

describe("RangePicker", () => {
  it("pre-fills the custom range with the window the page shows now, not the one it was mounted with", () => {
    const { rerender } = render(wrap(<RangePicker state={state} active="7d" from="2026-10-02" to="2026-10-08" today="2026-10-08" />));
    // the user picked 30 days meanwhile: the same component instance gets the new window
    rerender(wrap(<RangePicker state={state} active="30d" from="2026-09-09" to="2026-10-08" today="2026-10-08" />));
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(screen.getByTestId("ai-usage-from")).toHaveValue("2026-09-09");
    expect(screen.getByTestId("ai-usage-to")).toHaveValue("2026-10-08");
  });
});
