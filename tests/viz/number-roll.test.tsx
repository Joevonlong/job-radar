import { describe, expect, it, vi } from "vitest";

import { NumberRoll, type NumberRollProps } from "@/components/viz/number-roll";

import { renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

/** The text assistive technology gets (NumberFlow's own markup is aria-hidden and animated). */
function spoken(props: NumberRollProps, locale: "zh" | "en" = "zh"): string {
  const { container } = renderViz(<NumberRoll {...props} />, locale);
  return container.querySelector(".jr-sr")?.textContent ?? container.textContent ?? "";
}

describe("NumberRoll", () => {
  it.each([
    [{ value: 1284 }, "1,284"],
    [{ value: 41.37, format: "percent" as const }, "41%"],
    [{ value: 2.64, format: "percent" as const }, "2.6%"],
    [{ value: 9.96, format: "percent" as const }, "10%"],
    [{ value: 95000, format: { style: "currency", currency: "EUR", maximumFractionDigits: 0 } as const }, "€95,000"],
    [{ value: 88, suffix: "/100" }, "88/100"],
    [{ value: 0 }, "0"],
    [{ value: 3.14159, format: "decimal" as const }, "3.1"],
  ])("%j -> %s", (props, expected) => {
    expect(spoken(props)).toBe(expected);
  });

  it("a 7-digit count is written compact, the exact figure stays in the title and the spoken text", () => {
    const { container } = renderViz(<NumberRoll value={1953326} playOnView={false} />, "en");
    const root = container.querySelector<HTMLElement>(".jr-numroll");
    expect(root).toHaveAttribute("data-compact", "true");
    expect(root).toHaveAttribute("title", "1,953,326");
    expect(container.querySelector(".jr-sr")?.textContent).toBe("1,953,326");
    expect(container.querySelector("[data-number-flow], [aria-hidden]")?.textContent).toBe("1.95M");
    expect(spoken({ value: 99_999_999 })).toBe("99,999,999");
    const small = renderViz(<NumberRoll value={999999} playOnView={false} />, "en").container.querySelector(".jr-numroll");
    expect(small).not.toHaveAttribute("data-compact");
  });

  it("unknown is — and never 0", () => {
    const { container } = renderViz(<NumberRoll value={null} />);
    expect(container.textContent).toBe("—");
    expect(container.querySelector("[data-unknown]")).not.toBeNull();
    expect(renderViz(<NumberRoll value={Number.NaN} />).container.textContent).toBe("—");
  });

  it("a percentage below 0.1 is a statement, not a roll", () => {
    const { container } = renderViz(<NumberRoll value={0.04} format="percent" />);
    expect(container.textContent).toBe("<0.1%");
    expect(container.querySelector("[data-number-flow]")).toBeNull();
  });

  it("known values are rendered by NumberFlow, hidden from assistive technology", () => {
    const { container } = renderViz(<NumberRoll value={7} />);
    expect(container.querySelector("[data-number-flow]")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps grouping in English", () => {
    expect(spoken({ value: 12345 }, "en")).toBe("12,345");
  });
});
