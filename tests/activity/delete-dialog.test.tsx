import { NextIntlClientProvider } from "next-intl";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { DeleteDialog } from "@/components/activity-log/delete-dialog";
import { previewActivityDeleteAction, executeActivityDeleteAction } from "@/app/sources/logs/actions";

const { refresh, replace } = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace }) }));
vi.mock("@/app/sources/logs/actions", () => ({ previewActivityDeleteAction: vi.fn(), executeActivityDeleteAction: vi.fn() }));
const asOf = "2026-10-29T12:00:00.000Z";
const preview = vi.mocked(previewActivityDeleteAction);
const execute = vi.mocked(executeActivityDeleteAction);
beforeEach(() => { vi.resetAllMocks(); });
function mount(scope: "all" | "range" | "root" = "all") {
  render(<NextIntlClientProvider locale="en" messages={en}><DeleteDialog scope={scope} rootId="a1710000-0000-4000-8000-000000000001" today="2026-10-29" /></NextIntlClientProvider>);
}
describe("activity deletion dialog", () => {
  it("previews, confirms and continues the same scope/asOf, accumulating partial counts", async () => {
    preview.mockResolvedValue({ status: "ok", asOf, roots: 5, events: 12, skippedActive: 2 });
    execute.mockResolvedValueOnce({ status: "partial", roots: 1, events: 8 }).mockResolvedValueOnce({ status: "done", roots: 4, events: 4 });
    mount();
    fireEvent.click(screen.getByTestId("activity-log-delete-all"));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Clear all");
    fireEvent.click(screen.getByRole("button", { name: "Preview deletion" }));
    await screen.findByText("Will delete 5 entries and 12 events.");
    expect(screen.getByText("Skipped in progress: 2")).toBeVisible();
    const confirm = await screen.findByRole("button", { name: "Confirm deletion" });
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await screen.findByText("Partially complete: 1 entries and 8 events deleted so far.");
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(preview).toHaveBeenCalledWith({ scope: "all" });
    expect(execute.mock.calls).toEqual([[{ scope: "all", asOf }], [{ scope: "all", asOf }]]);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("freezes optional date inputs and reports safe failures inline", async () => {
    preview.mockResolvedValue({ status: "ok", asOf, roots: 2, events: 3, skippedActive: 0 });
    execute.mockResolvedValue({ status: "failed" });
    mount("range");
    fireEvent.click(screen.getByTestId("activity-log-delete-range"));
    expect(screen.getByTestId("activity-log-delete-to")).toHaveValue("2026-10-29");
    fireEvent.change(screen.getByTestId("activity-log-delete-from"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview deletion" }));
    await screen.findByText("Will delete 2 entries and 3 events.");
    expect(screen.queryByTestId("activity-log-delete-from")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm deletion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Deletion could not be completed.");
    expect(execute).toHaveBeenCalledWith({ scope: "range", from: "2026-10-01", to: "2026-10-29", asOf });
  });
});
