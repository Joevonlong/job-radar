/**
 * Inline CSS helpers of the hidden-text scanner: declarations of a `style` attribute, colours, WCAG contrast and lengths.
 * Only what an inline style can say is read; no stylesheet, no cascade beyond inheritance along the element's ancestors.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** `color: red; Background-Color : #FFF !important` → { color: "red", "background-color": "#FFF" } (last one wins, lower-case names). */
export function parseStyle(style: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!style) return out;
  for (const part of style.split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    const value = part
      .slice(at + 1)
      .replace(/!\s*important\s*$/i, "")
      .trim();
    if (name !== "" && value !== "") out.set(name, value);
  }
  return out;
}

/** The CSS colour names that matter in practice (the page-coloured ones first); anything else is "unknown". */
const NAMED: Record<string, string> = {
  white: "#ffffff",
  snow: "#fffafa",
  ivory: "#fffff0",
  whitesmoke: "#f5f5f5",
  ghostwhite: "#f8f8ff",
  azure: "#f0ffff",
  mintcream: "#f5fffa",
  floralwhite: "#fffaf0",
  seashell: "#fff5ee",
  linen: "#faf0e6",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  gainsboro: "#dcdcdc",
  darkgray: "#a9a9a9",
  dimgray: "#696969",
  red: "#ff0000",
  maroon: "#800000",
  orange: "#ffa500",
  yellow: "#ffff00",
  olive: "#808000",
  lime: "#00ff00",
  green: "#008000",
  aqua: "#00ffff",
  cyan: "#00ffff",
  teal: "#008080",
  blue: "#0000ff",
  navy: "#000080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  purple: "#800080",
  beige: "#f5f5dc",
};

const clamp255 = (n: number): number => Math.max(0, Math.min(255, n));

function channel(token: string): number | null {
  const t = token.trim();
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? clamp255(Math.round((n / 100) * 255)) : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? clamp255(n) : null;
}

function alpha(token: string | undefined): number {
  if (token === undefined) return 1;
  const t = token.trim();
  const n = t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [conv(hue + 1 / 3) * 255, conv(hue) * 255, conv(hue - 1 / 3) * 255];
}

/** A CSS colour (`#fff`, `#ffffff`, `#ffffff80`, `rgb()`, `rgba()`, `hsl()`, `hsla()`, a common name, `transparent`); null when unknown. */
export function parseColor(value: string | undefined | null): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[v];
  if (named) return parseColor(named);
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split("").map((c) => parseInt(c + c, 16));
      return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = (fn[2] ?? "").split(/\s*[,/]\s*|\s+/).filter((p) => p !== "");
  if (parts.length < 3) return null;
  if (fn[1]?.startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (r === null || g === null || b === null || r === undefined || g === undefined || b === undefined) return null;
    return { r, g, b, a: alpha(parts[3]) };
  }
  const h = Number((parts[0] ?? "").replace(/deg$/, ""));
  const s = Number((parts[1] ?? "").replace(/%$/, "")) / 100;
  const l = Number((parts[2] ?? "").replace(/%$/, "")) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  const [r, g, b] = hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alpha(parts[3]) };
}

/** `background: #fff url(x) no-repeat` → the colour part, if any. */
export function backgroundColorOf(declarations: Map<string, string>): Rgba | null {
  const direct = parseColor(declarations.get("background-color"));
  if (direct) return direct;
  const shorthand = declarations.get("background");
  if (!shorthand) return null;
  const whole = parseColor(shorthand);
  if (whole) return whole;
  for (const token of shorthand.match(/(?:rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}\b|[a-z]+/gi) ?? []) {
    const color = parseColor(token);
    if (color) return color;
  }
  return null;
}

/** `fg` drawn over `bg` (alpha compositing); `bg` is taken as opaque. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2 contrast ratio (1..21) of text colour `fg` on background `bg`. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const solidBg = { ...bg, a: 1 };
  const text = composite(fg, solidBg);
  const [hi, lo] = [luminance(text), luminance(solidBg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A CSS length in pixels (`0`, `-9999px`, `1pt`, `0.5em` at 16px, `0%` = 0); null when it is not a plain length. */
export function lengthPx(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^(-?\d*\.?\d+)\s*(px|pt|em|rem|%|vw|vh|ch|ex)?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "px").toLowerCase()) {
    case "pt":
      return (n * 4) / 3;
    case "em":
    case "rem":
    case "ch":
    case "ex":
      return n * 16;
    case "%":
      return n === 0 ? 0 : null;
    case "vw":
    case "vh":
      return n === 0 ? 0 : null;
    default:
      return n;
  }
}

/** The first length of a shorthand like `margin: -9999px 0` (each value of it, in pixels). */
export function lengthsPx(value: string | undefined | null): number[] {
  if (!value) return [];
  return value
    .trim()
    .split(/\s+/)
    .map(lengthPx)
    .filter((n): n is number => n !== null);
}
