import { parse } from "yaml";
import { z } from "zod";
import { letterHtml } from "./blocks";
import { CareerEngineError } from "./errors";
import { fontFaceCss } from "./fonts";
import { i18n } from "./i18n";
import { dataUrl, type Images } from "./images";
import { letterSignaturePath } from "./letter";
import { esc } from "./md";
import { Resume } from "./schema";
import { headingsOf } from "./sections";
import { style as baseStyle } from "./themes/base";
import { THEMES } from "./themes";

export function parseResume(text: string): Resume {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    const line = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    if (line !== undefined && /^\s*-\s+\[/.test(text.split("\n")[line - 1] ?? ""))
      (e as Error).message += '\nhint: wrap the whole item in quotes, e.g. - "[x] done" or - "[[GA]] shipped"';
    throw e;
  }
  const result = Resume.safeParse(doc);
  if (!result.success) throw new Error(`resume is not a valid resume:\n${z.prettifyError(result.error)}`);
  const problem = themeProblem(result.data.meta.theme);
  if (problem) throw new CareerEngineError(problem.code, problem.params);
  return result.data;
}

export function listThemes(): string[] {
  return Object.keys(THEMES);
}

export function themeProblem(name: string): { code: "career.theme.unknown"; params: { name: string; available: string } } | undefined {
  const themes = listThemes();
  return themes.includes(name) ? undefined : { code: "career.theme.unknown", params: { name, available: themes.join(", ") } };
}

export type Doc = "resume" | "letter";

export interface RenderOptions {
  theme?: string;
  images?: Images;
  today: string;
  doc?: Doc;
}

export const signaturePath = (r: Resume, doc: Doc = "resume") => (doc === "letter" ? letterSignaturePath(r) : r.meta.signature?.image);

export function renderResume(r: Resume, opts: RenderOptions): string {
  const themeName = opts.theme ?? r.meta.theme;
  const problem = themeProblem(themeName);
  if (problem) throw new CareerEngineError(problem.code, problem.params);
  const { template: theme, style } = THEMES[themeName];
  const letter = opts.doc === "letter";
  if (letter && !r.letter) throw new CareerEngineError("career.letter.missing");
  const photo = !letter && r.basics.photo && opts.images?.photo;
  const signature = signaturePath(r, opts.doc) && opts.images?.signature;
  const l10n = i18n(r.meta.lang);
  const ctx = {
    ...l10n,
    t: { ...l10n.t, ...headingsOf(r) },
    photoUrl: photo ? dataUrl(photo) : undefined,
    signatureUrl: signature ? dataUrl(signature) : undefined,
    today: opts.today,
  };

  return `<!doctype html>
<html lang="${r.meta.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.basics.name)} · ${esc(letter ? (r.letter!.subject ?? ctx.w.letter) : r.basics.title)}</title>
<meta name="description" content="${esc(r.basics.summary ?? r.basics.title)}">
<style>${fontFaceCss(theme.fonts)}</style>
<style>${baseStyle}</style>
<style>${style}</style>
<style>:root { --accent: ${r.meta.accent}; }</style>
</head>
<body class="theme-${themeName}" data-paper="${r.meta.paper}" data-density="${r.meta.density}"${r.meta.colors === "accent" ? ' data-colors="accent"' : ""}${letter ? ' data-doc="letter"' : ""}>
${letter ? (theme.letter ? theme.letter(r, ctx) : letterHtml(r, ctx)) : theme.render(r, ctx)}
</body>
</html>`;
}
