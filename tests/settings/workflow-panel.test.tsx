import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { WorkflowPanel } from "@/components/settings/workflow/workflow-panel";
import type { WorkflowView } from "@/lib/settings/workflow/types";

import en from "../../messages/en.json";

const action = vi.hoisted(() => ({ saveWorkflowAction: vi.fn() }));
vi.mock("@/app/settings/actions", () => ({ saveWorkflowAction: action.saveWorkflowAction }));
vi.mock("@/lib/toast", () => ({ toastTone: vi.fn(), toastUndo: vi.fn() }));

const view = (over: Partial<WorkflowView> = {}): WorkflowView => ({
  hash: "h1",
  draft: { hiddenStatuses: [], hiddenWorkplaces: [], hiddenContracts: [], interestedDays: "7", appliedDays: "14" },
  loadError: null,
  counts: { interested: 2, preparing: 3, applied: 1 },
  files: { ui: "data/config/ui.yaml", notify: "data/config/notify.yaml" },
  ...over,
});

function renderPanel(v: WorkflowView = view()) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkflowPanel view={v} ack={null} repairHref={(file) => `/settings?tab=advanced&file=${file}`} />
    </NextIntlClientProvider>,
  );
}

describe("WorkflowPanel", () => {
  it("lists the nine statuses with their count; new and ignored cannot be hidden and say why", () => {
    renderPanel();
    expect(screen.getAllByTestId(/^status-row-/)).toHaveLength(9);
    expect(screen.getByTestId("status-count-preparing")).toHaveTextContent("3");
    expect(screen.getByTestId("status-show-new")).toBeDisabled();
    expect(screen.getByTestId("status-show-archived")).toBeDisabled();
    expect(within(screen.getByTestId("status-row-new")).getByText(/Cannot be hidden/)).toBeInTheDocument();
    expect(screen.getByTestId("status-show-preparing")).toBeEnabled();
  });

  it("only 'interested' and 'applied' have a timeout", () => {
    renderPanel();
    expect(screen.getByTestId("status-days-interested")).toHaveValue("7");
    expect(screen.getByTestId("status-days-applied")).toHaveValue("14");
    expect(screen.queryByTestId("status-days-offer")).toBeNull();
  });

  it("hiding a status that holds cards says where they go, and the save sends exactly what changed", async () => {
    const user = userEvent.setup();
    action.saveWorkflowAction.mockResolvedValue({ status: "idle" });
    renderPanel();
    expect(screen.getByTestId("workflow-save")).toBeDisabled();
    await user.click(screen.getByTestId("status-show-preparing"));
    expect(screen.getByTestId("status-folds-preparing")).toHaveTextContent("3 cards");
    const days = screen.getByTestId("status-days-interested");
    await user.clear(days);
    await user.type(days, "3");
    await user.click(screen.getByTestId("workplace-show-onsite"));
    await user.click(screen.getByTestId("workflow-save"));
    expect(action.saveWorkflowAction).toHaveBeenCalledTimes(1);
    expect(action.saveWorkflowAction.mock.calls[0]?.[1]).toEqual({ hiddenStatuses: ["preparing"], hiddenWorkplaces: ["onsite"], hiddenContracts: [], interestedDays: "3", appliedDays: "14" });
  });

  it("shows the repair link when a file cannot be read", () => {
    renderPanel(view({ draft: null, loadError: { file: "ui", message: "salary_axis: expected object" } }));
    expect(screen.getByTestId("repair-link")).toHaveAttribute("href", "/settings?tab=advanced&file=ui");
    expect(screen.queryByTestId("status-table")).toBeNull();
  });
});
