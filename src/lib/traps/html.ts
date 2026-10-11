/**
 * The HTML part of the rule layer: text a page hides with inline styles or attributes, instructions in comments and
 * attributes, and the content of elements that are never rendered. The HTML is untrusted data (C6): it is parsed, never rendered,
 * and only text leaves this module. External stylesheets are not read (a class hides only when traps.yaml lists it).
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

import { decodeHtml } from "@/lib/channels/ats/text";
import type { TrapsConfig } from "@/lib/config/schemas/traps";

import { backgroundColorOf, contrastRatio, lengthPx, lengthsPx, parseColor, parseStyle, type Rgba } from "./css";
import { firstInstruction } from "./instructions";
import { NON_RENDERED_TAGS, type HiddenMethod, type HtmlFragment, type RawFinding } from "./types";

const MAX_EVIDENCE = 200;
/** Attributes whose text never reaches the JD text: only an instruction in them is reported. */
const TEXT_ATTRIBUTES = new Set(["alt", "title", "aria-label", "aria-description", "placeholder", "label"]);
const DEFAULT_TEXT: Rgba = { r: 0, g: 0, b: 0, a: 1 };

interface Context {
  /** Inherited text colour; null = the browser default (black). */
  color: Rgba | null;
  /** Nearest background an ancestor (or the element) sets inline; null = none set. */
  background: Rgba | null;
}

interface Hidden {
  method: HiddenMethod;
  evidence: string;
}

/** Spaces squeezed, trimmed. */
export function squash(text: string): string {
  return text.replace(/[\s\u00A0]+/gu, " ").trim();
}

const clipEvidence = (text: string): string => (text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text);

function styleEvidence(el: Element): string {
  return clipEvidence(`style="${(el.attribs.style ?? "").trim()}"`);
}

function textColorOf(el: Element, declarations: Map<string, string>): Rgba | null {
  const fromStyle = parseColor(declarations.get("color"));
  if (fromStyle) return fromStyle;
  return el.name.toLowerCase() === "font" ? parseColor(el.attribs.color) : null;
}

function ownBackground(el: Element, declarations: Map<string, string>): Rgba | null {
  const fromStyle = backgroundColorOf(declarations);
  if (fromStyle && fromStyle.a > 0) return fromStyle;
  const attr = parseColor(el.attribs.bgcolor);
  return attr && attr.a > 0 ? attr : null;
}

/** Why `el` hides its content, or null. The first enabled method that applies wins. */
function hiddenBy(el: Element, declarations: Map<string, string>, context: Context, settings: TrapsConfig["hidden"]): Hidden | null {
  const on = settings.methods;
  const attrs = el.attribs;
  if (on.hidden_attribute && "hidden" in attrs) return { method: "hidden_attribute", evidence: "hidden" };
  if (on.display_none && declarations.get("display")?.toLowerCase() === "none") return { method: "display_none", evidence: styleEvidence(el) };
  if (on.visibility_hidden && /^(?:hidden|collapse)$/i.test(declarations.get("visibility") ?? "")) return { method: "visibility_hidden", evidence: styleEvidence(el) };
  const opacity = Number(declarations.get("opacity"));
  if (on.opacity && declarations.has("opacity") && Number.isFinite(opacity) && opacity <= settings.opacity_max) return { method: "opacity", evidence: styleEvidence(el) };

  const overflowCut = /^(?:hidden|clip)$/i.test(declarations.get("overflow") ?? "") || /^(?:hidden|clip)$/i.test(declarations.get("overflow-y") ?? "");
  if (on.font_size) {
    const size = lengthPx(declarations.get("font-size"));
    if (size !== null && size <= settings.font_size_max_px) return { method: "font_size", evidence: styleEvidence(el) };
    const lineHeight = lengthPx(declarations.get("line-height"));
    const height = lengthPx(declarations.get("height") ?? declarations.get("max-height"));
    if (lineHeight !== null && lineHeight <= settings.font_size_max_px && (overflowCut || (height !== null && height <= settings.size_max_px))) {
      return { method: "font_size", evidence: styleEvidence(el) };
    }
  }
  if (on.offscreen) {
    const far = -settings.offscreen_min_px;
    const values = [
      lengthPx(declarations.get("left")),
      lengthPx(declarations.get("top")),
      lengthPx(declarations.get("text-indent")),
      lengthPx(declarations.get("margin-left")),
      lengthPx(declarations.get("margin-top")),
      ...lengthsPx(declarations.get("margin")),
      ...[...(declarations.get("transform") ?? "").matchAll(/translate[xy3d]?\(\s*(-?\d*\.?\d+)px/gi)].map((m) => Number(m[1])),
    ];
    if (values.some((v) => v !== null && v <= far)) return { method: "offscreen", evidence: styleEvidence(el) };
  }
  if (on.clip) {
    const clip = declarations.get("clip");
    const clipNumbers = clip ? [...clip.matchAll(/-?\d*\.?\d+/g)].map((m) => Number(m[0])) : [];
    if (clip && /^rect\(/i.test(clip.trim()) && clipNumbers.length >= 4 && clipNumbers.every((n) => Math.abs(n) <= 1)) return { method: "clip", evidence: styleEvidence(el) };
    const path = declarations.get("clip-path")?.trim().toLowerCase() ?? "";
    const inset = /^inset\(\s*(\d*\.?\d+)%/.exec(path);
    if ((inset && Number(inset[1]) >= 50) || /^circle\(\s*0(?:px|%)?\s*(?:\)|at\b)/.test(path) || /^polygon\(\s*0(?:px)?\s+0(?:px)?\s*(?:,\s*0(?:px)?\s+0(?:px)?\s*)*\)$/.test(path)) {
      return { method: "clip", evidence: styleEvidence(el) };
    }
  }
  if (on.zero_size && overflowCut) {
    const sizes = ["width", "height", "max-width", "max-height"].map((name) => lengthPx(declarations.get(name)));
    if (sizes.some((v) => v !== null && v <= settings.size_max_px)) return { method: "zero_size", evidence: styleEvidence(el) };
  }
  if (on.aria_hidden && attrs["aria-hidden"]?.trim().toLowerCase() === "true") return { method: "aria_hidden", evidence: 'aria-hidden="true"' };
  if (on.hidden_class && attrs.class) {
    const listed = new Set(settings.classes.map((c) => c.toLowerCase()));
    const hit = attrs.class.split(/\s+/).find((c) => listed.has(c.toLowerCase()));
    if (hit) return { method: "hidden_class", evidence: clipEvidence(`class="${hit}"`) };
  }
  if (on.color_match) {
    const own = textColorOf(el, declarations);
    const bg = ownBackground(el, declarations);
    if (own !== null || bg !== null) {
      const fg = own ?? context.color ?? DEFAULT_TEXT;
      const background = bg ?? context.background;
      const backgrounds = background ? [background] : settings.color.assumed_background.map(parseColor).filter((c): c is Rgba => c !== null);
      if (backgrounds.some((b) => contrastRatio(fg, b) < settings.color.min_contrast)) {
        const evidence = el.name.toLowerCase() === "font" && el.attribs.color && !el.attribs.style ? `<font color="${el.attribs.color}">` : styleEvidence(el);
        return { method: "color_match", evidence: clipEvidence(evidence) };
      }
    }
  }
  return null;
}

function childContext(el: Element, declarations: Map<string, string>, context: Context): Context {
  return { color: textColorOf(el, declarations) ?? context.color, background: ownBackground(el, declarations) ?? context.background };
}

/** Whether a hidden text is worth reporting: long enough and not on the harmless list (an instruction always is). */
function reportable(text: string, instructionId: string | null, settings: TrapsConfig): boolean {
  if (text === "") return false;
  if (instructionId !== null) return true;
  if ([...text].length < settings.scan.min_hidden_chars) return false;
  return !settings.hidden.benign.some((source) => new RegExp(source, "iu").test(text));
}

/** The rule findings of one HTML fragment of a source posting. */
export function scanHtml(fragment: HtmlFragment, settings: TrapsConfig): RawFinding[] {
  const html = fragment.escaped ? decodeHtml(fragment.html) : fragment.html;
  if (html.trim() === "") return [];
  const $ = cheerio.load(html, null, false);
  const out: RawFinding[] = [];
  const base = { path: fragment.path, offset: null } as const;

  const walk = (node: AnyNode, context: Context): void => {
    if (node.type === "comment") {
      const text = squash(node.data);
      const instructionId = text === "" ? null : firstInstruction(text, settings);
      if (instructionId !== null) out.push({ ...base, technique: "html_comment", method: "comment", severity: "trap", text, path: `${fragment.path}#comment`, evidence: "<!-- -->", instructionId, detail: {} });
      return;
    }
    if (node.type === "root") {
      for (const child of node.children) walk(child, context);
      return;
    }
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
    const el = node as Element;
    const tag = el.name.toLowerCase();

    for (const [name, value] of Object.entries(el.attribs)) {
      const attr = name.toLowerCase();
      if (!TEXT_ATTRIBUTES.has(attr) && !attr.startsWith("data-")) continue;
      const text = squash(value);
      const instructionId = text === "" ? null : firstInstruction(text, settings);
      if (instructionId !== null) out.push({ ...base, technique: "attribute_text", method: "attribute", severity: "trap", text, path: `${fragment.path}@${attr}`, evidence: clipEvidence(`${attr}="…"`), instructionId, detail: {} });
    }

    if ((NON_RENDERED_TAGS as readonly string[]).includes(tag)) {
      const text = squash($(el).text());
      if (text !== "") {
        const instructionId = firstInstruction(text, settings);
        out.push({ ...base, technique: "non_rendered", method: tag as (typeof NON_RENDERED_TAGS)[number], severity: instructionId ? "trap" : "suspicious", text, evidence: `<${tag}>`, instructionId, detail: {} });
      }
      return;
    }

    const declarations = parseStyle(el.attribs.style);
    const hidden = hiddenBy(el, declarations, context, settings.hidden);
    if (hidden) {
      const text = squash($(el).text());
      const instructionId = text === "" ? null : firstInstruction(text, settings);
      if (reportable(text, instructionId, settings)) {
        out.push({ ...base, technique: "hidden_text", method: hidden.method, severity: instructionId ? "trap" : "suspicious", text, evidence: hidden.evidence, instructionId, detail: {} });
      }
      return; // only the outermost hidden element is reported
    }
    const next = childContext(el, declarations, context);
    for (const child of el.children) walk(child, next);
  };

  for (const node of $.root().contents().toArray()) walk(node, { color: null, background: null });
  return out;
}
