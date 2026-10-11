import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import zh from "../../messages/zh.json";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("/dev/viz", () => {
  it("is a 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: Page } = await import("@/app/dev/viz/page");
    expect(() => Page()).toThrow(expect.objectContaining({ digest: expect.stringContaining("404") }));
  });

  it("shows every component in its states without a broken number", async () => {
    const { default: Page } = await import("@/app/dev/viz/page");
    const element = Page();
    const { container } = render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        {element}
      </NextIntlClientProvider>,
    );
    expect(container.querySelector("[data-theme-button=dark]")).not.toBeNull();
    const titles = Array.from(container.querySelectorAll("section > header > h2")).map((h) => h.textContent);
    expect(titles).toEqual(
      expect.arrayContaining([
        "NumberRoll", "ScoreMeter", "ScoreComposition", "SalaryAxis", "SalaryMini", "Percentile", "PercentText", "PercentBar", "Fraction", "SegBlocks", "Waffle", "Ring",
        "Battery", "Stacked100", "Delta + PairBars", "Sparkline", "LevelScale", "SkillOverlap", "Freshness", "Funnel", "UptimeStrip", "Led", "Ticker", "TermLog",
      ]),
    );
    expect(container.textContent).not.toMatch(/NaN|undefined|Infinity/);
    // every graphic that claims to be a meter carries its range
    for (const meter of Array.from(container.querySelectorAll('[role="meter"]'))) {
      expect(meter, meter.outerHTML.slice(0, 120)).toHaveAttribute("aria-valuenow");
      expect(meter).toHaveAttribute("aria-valuemin");
      expect(meter).toHaveAttribute("aria-valuemax");
      expect(meter.getAttribute("aria-label") ?? "").not.toBe("");
    }
  });
});
