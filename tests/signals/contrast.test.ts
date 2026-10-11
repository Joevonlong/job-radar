import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Design system v3 (docs/design/tokens.md): text is always an ink shade; signal colours only fill blocks that carry
// their own 2px border and a label, with --on-signal text on top. Check the pairs that carry text in both themes.
const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/app/globals.css"), "utf8");

type Rgb = [number, number, number];

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf("\n}", start));
}

/** Every `--name: #hex;` declaration of a block. */
function hexTokens(scope: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of scope.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    if (match[1] && match[2]) out.set(match[1], match[2]);
  }
  return out;
}

const hex = (value: string): Rgb => {
  const h = value.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};

function luminance([r, g, b]: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const light = hexTokens(block(":root,\n.light"));
const themes = {
  light,
  dark: new Map([...light, ...hexTokens(block(".dark"))]),
} as const;

function colour(theme: keyof typeof themes, name: string): Rgb {
  const value = themes[theme].get(name);
  if (!value) throw new Error(`no --${name} in ${theme}`);
  return hex(value);
}

describe.each(["light", "dark"] as const)("v3 text contrast, %s theme", (theme) => {
  it.each([
    ["ink", "bg"],
    ["ink", "card-bg"],
    ["ink", "soft"],
    ["ink-2", "bg"],
    ["ink-2", "card-bg"],
    ["ink-2", "soft"],
    ["hi-ink", "hi"],
    ["on-bad", "bad"],
    ["on-signal", "signal-t1"],
    ["on-signal", "signal-t2"],
    ["on-signal", "signal-t3"],
    ["on-signal", "signal-t4"],
    ["on-signal", "warn"],
  ])("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(colour(theme, fg), colour(theme, bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("ink-3 (ticks, hints) on the card is at least 4.5:1", () => {
    expect(contrast(colour(theme, "ink-3"), colour(theme, "card-bg"))).toBeGreaterThanOrEqual(4.5);
  });
});
