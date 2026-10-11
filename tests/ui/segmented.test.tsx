import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";

function Demo({ onChange }: { onChange?: (value: string) => void }) {
  const [view, setView] = useState("list");
  return (
    <Segmented
      aria-label="View"
      value={view}
      onValueChange={(next) => {
        setView(next);
        onChange?.(next);
      }}
    >
      <SegmentedItem value="list">List</SegmentedItem>
      <SegmentedItem value="board" count={12}>
        Board
      </SegmentedItem>
      <SegmentedItem value="table">Table</SegmentedItem>
    </Segmented>
  );
}

describe("Segmented", () => {
  it("is a radiogroup with the selected segment checked", () => {
    render(<Demo />);
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "List" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Board/ })).not.toBeChecked();
  });

  it("shows the count next to the label", () => {
    render(<Demo />);
    expect(screen.getByRole("radio", { name: /Board/ })).toHaveTextContent("12");
  });

  it("moves and selects with the arrow keys", async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("radio", { name: "List" })).toHaveFocus();
    // Radix selects on the animation frame after focus moves, and only while the arrow key is still down.
    const press = async (key: string, expected: RegExp) => {
      await user.keyboard(`{${key}>}`);
      await waitFor(() => expect(screen.getByRole("radio", { name: expected })).toBeChecked());
      await user.keyboard(`{/${key}}`);
    };
    await press("ArrowRight", /Board/);
    expect(onChange).toHaveBeenLastCalledWith("board");
    await press("ArrowRight", /Table/);
    await press("ArrowLeft", /Board/);
    await press("ArrowLeft", /List/);
  });

  it("selects on click and works uncontrolled", async () => {
    render(
      <Segmented aria-label="Range" defaultValue="7">
        <SegmentedItem value="7">7d</SegmentedItem>
        <SegmentedItem value="30">30d</SegmentedItem>
      </Segmented>,
    );
    await userEvent.click(screen.getByRole("radio", { name: "30d" }));
    expect(screen.getByRole("radio", { name: "30d" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "7d" })).not.toBeChecked();
  });

  it("the sliding indicator sits inside the checked segment and follows the selection", async () => {
    render(<Demo />);
    const slider = () => document.querySelectorAll("[data-slot=segmented-slider]");
    expect(slider()).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "List" }).contains(slider()[0] ?? null)).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /Board/ }));
    expect(slider()).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Board/ }).contains(slider()[0] ?? null)).toBe(true);
  });
});
