import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { AgentActivity } from "@/components/agents/activity";
import { toActivityRow, type AgentActivityData } from "@/lib/agent-access/activity";
import type { AgentCallListRow } from "@/lib/db/repos/agent-calls";

import en from "../../messages/en.json";

const base: AgentCallListRow = {
  id: 1,
  calledAt: new Date("2026-11-11T11:00:00Z"),
  cursorAt: "2026-11-11T11:00:00.000000Z",
  caller: "stdio",
  tokenId: null,
  tokenName: null,
  tokenRevoked: false,
  transport: "stdio",
  capability: "get_job",
  targetType: "job",
  targetId: 4,
  jobId: 4,
  jobTitle: "Backend Engineer",
  company: "Example GmbH",
  outcome: "ok",
  errorCategory: null,
  returnedCount: 1,
  durationMs: 12,
};

function data(rows: AgentActivityData["rows"], extra: Partial<AgentActivityData> = {}): AgentActivityData {
  return {
    query: {},
    range: "7d",
    pageSize: 50,
    retentionDays: 90,
    connections: [{ id: 3, name: "Old notebook", revoked: true }],
    tools: [{ id: "get_job", permission: "jobs:read" }],
    outcomes: ["ok", "not_permitted", "invalid_input", "error"],
    rows,
    nextBefore: null,
    summary: { total: rows.length, byOutcome: rows.length ? { ok: rows.length } : {} },
    anyCalls: true,
    timeZone: "UTC",
    ...extra,
  };
}

const view = (d: AgentActivityData) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AgentActivity data={d} now="2026-11-11T12:00:00Z" />
    </NextIntlClientProvider>,
  );

describe("AgentActivity", () => {
  it("leaves the undo column empty without a loader and shows the registered state with one", () => {
    const first = view(data([toActivityRow(base, undefined)]));
    expect(screen.queryAllByTestId("agents-activity-undo")).toHaveLength(0);
    first.unmount();
    view(data([toActivityRow(base, "undoable"), toActivityRow({ ...base, id: 2 }, "undone")]));
    expect(screen.getAllByTestId("agents-activity-undo").map((node) => node.getAttribute("data-state"))).toEqual(["undoable", "undone", "undoable", "undone"]);
  });

  it("links a resolved target to its job and writes #id for an unresolved one; a revoked token is marked", () => {
    view(
      data([
        toActivityRow({ ...base, caller: "token:3", tokenId: 3, tokenName: "Old notebook", tokenRevoked: true }, undefined),
        toActivityRow({ ...base, id: 2, targetType: "application", targetId: 8, jobId: null, jobTitle: null, company: null }, undefined),
      ]),
    );
    const table = screen.getByTestId("agents-activity-table");
    const link = within(table).getByRole("link", { name: "Backend Engineer · Example GmbH" });
    expect(link).toHaveAttribute("href", "/jobs/4");
    expect(within(table).getAllByTestId("agents-activity-target")[1]).toHaveTextContent("Application #8");
    expect(within(table).getAllByText("revoked")).toHaveLength(1);
  });

  it("tells apart no calls yet from no calls after filtering", () => {
    const first = view(data([], { anyCalls: false }));
    expect(screen.getByTestId("agents-activity-empty")).toHaveTextContent("No agent calls yet");
    expect(screen.getByRole("link", { name: "Set up agent access" })).toHaveAttribute("href", "/settings/agents");
    first.unmount();
    view(data([], { anyCalls: true, query: { result: "error" } }));
    expect(screen.getByTestId("agents-activity-empty-filtered")).toBeInTheDocument();
    expect(within(screen.getByTestId("agents-activity-empty-filtered")).getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/settings/agents/activity");
  });

  it("keeps the filters in the link to older calls and offers a way back", () => {
    view(data([toActivityRow(base, undefined)], { query: { tool: "get_job", before: "2026-11-11T12:00:00.000000Z~9" }, nextBefore: "2026-11-11T11:00:00.000000Z~1" }));
    expect(screen.getByTestId("agents-activity-older")).toHaveAttribute("href", "/settings/agents/activity?tool=get_job&before=2026-11-11T11%3A00%3A00.000000Z%7E1");
    expect(screen.getByTestId("agents-activity-newest")).toHaveAttribute("href", "/settings/agents/activity?tool=get_job");
  });
});
