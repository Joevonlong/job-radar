import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MARK_FILLS } from "@/components/jobs/company-mark";

/**
 * Text contrast of the tokens (WCAG, small text needs 4.5:1), computed from the real values in `globals.css`, so a token change
 * that makes small text unreadable fails here (`--ink-3` on `--soft` was 3.8:1, the company mark's ink on green 3.76:1).
 */
const css = fs.readFileSync(path.join(__dirname, "../../src/app/globals.css"), "utf8");

function block(selector: RegExp): Record<string, string> {
  const match = css.match(selector);
  if (!match) throw new Error(`no block for ${selector}`);
  const vars: Record<string, string> = {};
  for (const [, name, value] of match[1]!.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) vars[name!] = value!;
  return vars;
}

const light = block(/:root,\s*\.light\s*\{([\s\S]*?)\n\}/);
const dark = { ...light, ...block(/\n\.dark\s*\{([\s\S]*?)\n\}/) };
const THEMES = { light, dark } as const;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("token contrast (small text, 4.5:1)", () => {
  for (const [name, vars] of Object.entries(THEMES)) {
    it(`${name}: --ink-3 on the page, the card and the soft fill`, () => {
      for (const surface of ["bg", "card-bg", "soft"]) expect(contrast(vars["ink-3"]!, vars[surface]!), `${surface}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: --ink-2 and --ink on every surface`, () => {
      for (const text of ["ink", "ink-2"]) for (const surface of ["bg", "card-bg", "soft"]) expect(contrast(vars[text]!, vars[surface]!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: --hi-ink on the --hi card (the yellow hero tile of /insights, its small notes included)`, () => {
      expect(contrast(vars["hi-ink"]!, vars["hi"]!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: ink text (--on-signal) on every signal category colour (signal palette)`, () => {
      for (const color of ["signal-t1", "signal-t2", "signal-t3", "signal-t4", "signal-olive", "signal-violet", "signal-slate", "signal-pink"]) {
        expect(vars[color], color).toBeDefined();
        expect(contrast(vars["on-signal"]!, vars[color]!), color).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: card date row and both density control states`, () => {
      expect(contrast(vars["ink-2"]!, vars["card-bg"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars["ink"]!, vars["card-bg"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars["bg"]!, vars["ink"]!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: every company mark fill has readable initials`, () => {
      // the picked class is the colour that renders: nothing else in jobs.css sets one on the mark (it did, and won)
      const markRule = fs.readFileSync(path.join(__dirname, "../../src/components/jobs/jobs.css"), "utf8").match(/\.jb-mark\s*\{([^}]*)\}/)?.[1] ?? "";
      expect(markRule).not.toMatch(/(^|[;\s])color:/);
      for (const { bg, text } of MARK_FILLS) {
        const fill = vars[bg.replace("bg-", "")]!;
        const ink = vars[text.replace("text-", "")]!;
        expect(fill, bg).toBeDefined();
        expect(ink, text).toBeDefined();
        expect(contrast(ink, fill), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
