import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MoreActions } from "@/components/jobs/detail/more-actions";
import { overrideActionFor } from "@/components/jobs/filter-notice";

import en from "../../messages/en.json";

const mocks = vi.hoisted(() => ({ setFilterOverrideAction: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/app/jobs/[id]/filter-actions", () => ({ setFilterOverrideAction: mocks.setFilterOverrideAction }));

beforeEach(() => vi.clearAllMocks());

describe("MoreActions", () => {
  it("is one icon button with a name; the filter decision is in its menu", async () => {
    mocks.setFilterOverrideAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <MoreActions jobId={18} overrideAction="exclude" />
      </NextIntlClientProvider>,
    );
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(screen.queryByTestId("filter-override-exclude")).toBeNull();
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Exclude this job" }));
    await waitFor(() => expect(mocks.setFilterOverrideAction).toHaveBeenCalledWith({ jobId: 18, action: "exclude" }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Saved"));
  });

  it("offers the action the rank calls for", () => {
    expect(overrideActionFor(null)).toBeNull();
    expect(overrideActionFor({ filterResult: "passed", filterReasons: [] })).toBe("exclude");
    expect(overrideActionFor({ filterResult: "filtered_out", filterReasons: ["salary_below_floor:70000"] })).toBe("keep");
  });
});
