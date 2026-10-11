// @vitest-environment node
import { describe, expect, it } from "vitest";

import { backgroundColorOf, contrastRatio, lengthPx, parseColor, parseStyle } from "@/lib/traps/css";

describe("inline CSS helpers", () => {
  it("parses declarations: lower-case names, last one wins, !important dropped", () => {
    const style = parseStyle("Color: RED; background-color : #FFF !important;; color: #000");
    expect(style.get("color")).toBe("#000");
    expect(style.get("background-color")).toBe("#FFF");
  });

  it("parses hex, rgb(a), hsl(a), names and transparent", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#FFFFFF80")?.a).toBeCloseTo(128 / 255);
    expect(parseColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("rgba(0 0 0 / 50%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("hsl(0, 0%, 100%)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("White")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("computes WCAG contrast", () => {
    const white = parseColor("#fff")!;
    const black = parseColor("#000")!;
    expect(contrastRatio(white, white)).toBeCloseTo(1);
    expect(contrastRatio(black, white)).toBeCloseTo(21);
    expect(contrastRatio(parseColor("#fefefe")!, white)).toBeLessThan(1.5);
    // transparent text on anything is invisible
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 0 }, white)).toBeCloseTo(1);
  });

  it("reads the colour of the background shorthand and lengths in px", () => {
    expect(backgroundColorOf(parseStyle("background: #000 url(x.png) no-repeat"))).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(lengthPx("-9999px")).toBe(-9999);
    expect(lengthPx("0")).toBe(0);
    expect(lengthPx("0.5em")).toBe(8);
    expect(lengthPx("1pt")).toBeCloseTo(4 / 3);
    expect(lengthPx("50%")).toBeNull();
  });
});
