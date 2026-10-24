import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { arrangeOptions, MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

beforeAll(() => {
  // jsdom: cmdk scrolls the highlighted item into view
  Element.prototype.scrollIntoView = vi.fn();
});

const options: MultiSelectOption[] = [
  { value: "Berlin", label: "Berlin", group: "Target cities" },
  { value: "München", label: "München", group: "Target cities" },
  { value: "Hamburg", label: "Hamburg", group: "Other cities" },
];

function Harness({ layout = "popover", initial = [], initialVisible, searchable = true, extra = [], locale = "en", onCommit, onChangeSpy }: { layout?: "popover" | "inline"; initial?: string[]; initialVisible?: number; searchable?: boolean; extra?: MultiSelectOption[]; locale?: "en" | "zh"; onCommit?: () => void; onChangeSpy?: (v: string[]) => void }) {
  const [value, setValue] = useState<string[]>(initial);
  const [expanded, setExpanded] = useState(false);
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      <MultiSelect
        label="City"
        options={[...extra, ...options]}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChangeSpy?.(next);
        }}
        onCommit={onCommit}
        searchable={searchable}
        initialVisible={initialVisible}
        searchPlaceholder="Search cities…"
        anyLabel="All"
        hint="Matches any of them"
        layout={layout}
        expanded={expanded}
        onExpandedChange={setExpanded}
        testId="filter-city"
      />
    </NextIntlClientProvider>
  );
}

const trigger = () => screen.getByTestId("filter-city");
const checked = (value: string) => screen.getAllByTestId("filter-city-option").find((o) => o.getAttribute("data-value") === value)?.getAttribute("aria-checked");

describe("MultiSelect: popover layout", () => {
  it("opens with Enter, focuses the search box, filters ignoring case and accents, ticks with ↓ + Enter and stays open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveTextContent("All");

    trigger().focus();
    await user.keyboard("{Enter}");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const search = screen.getByPlaceholderText("Search cities…");
    expect(search).toHaveFocus();
    expect(screen.getByText("Matches any of them")).toBeInTheDocument();
    expect(screen.getByText("Target cities")).toBeInTheDocument();

    await user.keyboard("munc");
    expect(screen.getAllByTestId("filter-city-option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(checked("München")).toBe("true");
    // still open; the trigger shows the pick
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveTextContent("München");
    expect(trigger()).toHaveAttribute("aria-label", "City: München");
  });

  it("opens with the down arrow, moves with ↑ ↓, and a space in the search box is text, not a tick", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(checked("München")).toBe("true");
    expect(checked("Berlin")).toBe("false");
    await user.keyboard(" ");
    expect(screen.getByPlaceholderText("Search cities…")).toHaveValue(" ");
    expect(checked("München")).toBe("true");
  });

  it("shows no-match text, the count, and summarises several picks as first + rest", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["München", "Berlin", "Hamburg"]} />);
    expect(trigger()).toHaveTextContent("München +2");
    expect(trigger()).toHaveAttribute("aria-label", "City: München, Berlin, Hamburg");
    await user.click(trigger());
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    await user.keyboard("zzzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("joins the names with 、 in Chinese", () => {
    render(<Harness initial={["München", "Berlin"]} locale="zh" />);
    expect(trigger()).toHaveAttribute("aria-label", "City：München、Berlin");
    expect(trigger()).toHaveTextContent("München +1");
  });

  it("Esc closes, hands the focus back to the trigger and commits; Clear empties; Done closes", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial={["Berlin"]} />);
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveFocus();
    expect(onCommit).toHaveBeenCalledTimes(1);

    await user.click(trigger());
    await user.click(screen.getByTestId("filter-city-clear"));
    expect(trigger()).toHaveTextContent("All");
    await user.click(screen.getByTestId("filter-city-done"));
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("lists a picked value no job has first, marked, and lets it be unticked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={["Gone"]} extra={[{ value: "Gone", label: "Gone", stale: true }]} onChangeSpy={onChange} />);
    await user.click(trigger());
    const first = screen.getAllByTestId("filter-city-option")[0] as HTMLElement;
    expect(first).toHaveAttribute("data-value", "Gone");
    expect(within(first).getByText("no jobs now")).toBeInTheDocument();
    await user.click(first);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("works without a search box: the list takes the focus", async () => {
    const user = userEvent.setup();
    render(<Harness searchable={false} />);
    await user.click(trigger());
    expect(screen.queryByPlaceholderText("Search cities…")).toBeNull();
    await user.keyboard("{Enter}");
    expect(checked("Berlin")).toBe("true");
  });
});

describe("MultiSelect: inline layout (the phone sheet)", () => {
  it("unfolds in place with a 44px+ checkbox list, ticks values and folds again", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness layout="inline" onCommit={onCommit} />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("filter-city-option")).toHaveLength(0);

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("filter-city-option")).toHaveLength(3);
    await user.click(screen.getAllByTestId("filter-city-option")[1] as HTMLElement);
    expect(trigger()).toHaveTextContent("München");
    expect(checked("München")).toBe("true");
    await user.type(screen.getByTestId("filter-city-search"), "ham");
    expect(screen.getAllByTestId("filter-city-option")).toHaveLength(1);

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("MultiSelect: order when opened", () => {
  it.each(["popover", "inline"] as const)("%s: keeps a newly picked option beyond the limit visible after clearing search", async (layout) => {
    const user = userEvent.setup();
    render(<Harness layout={layout} initialVisible={1} />);
    await user.click(trigger());
    expect(screen.getAllByTestId("filter-city-option").map((o) => o.getAttribute("data-value"))).toEqual(["Berlin"]);

    const search = screen.getByTestId("filter-city-search");
    await user.type(search, "ham");
    await user.click(screen.getByTestId("filter-city-option"));
    expect(checked("Hamburg")).toBe("true");
    await user.clear(search);

    expect(screen.getAllByTestId("filter-city-option").map((o) => o.getAttribute("data-value"))).toEqual(["Berlin", "Hamburg"]);
    expect(checked("Hamburg")).toBe("true");
  });

  it("arrangeOptions lists the picked values first, keeping their relative order, then the rest by group", () => {
    const { stale, groups } = arrangeOptions(options, ["München", "Berlin"]);
    expect(stale.map((o) => o.value)).toEqual(["Berlin", "München"]);
    expect(groups.map((g) => [g.heading, g.items.map((o) => o.value)])).toEqual([["Other cities", ["Hamburg"]]]);
    expect(arrangeOptions(options, []).groups.map((g) => g.heading)).toEqual(["Target cities", "Other cities"]);
  });

  it.each(["popover", "inline"] as const)("%s: picked rows come first on open and rows do not jump while ticking", async (layout) => {
    const user = userEvent.setup();
    render(<Harness layout={layout} initial={["Hamburg"]} />);
    await user.click(trigger());
    const order = () => screen.getAllByTestId("filter-city-option").map((o) => o.getAttribute("data-value"));
    expect(order()).toEqual(["Hamburg", "Berlin", "München"]);
    await user.click(screen.getAllByTestId("filter-city-option")[2] as HTMLElement);
    await user.click(screen.getAllByTestId("filter-city-option")[0] as HTMLElement);
    expect(order()).toEqual(["Hamburg", "Berlin", "München"]);
  });
});
