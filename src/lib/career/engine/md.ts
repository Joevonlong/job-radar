import { UNIT } from "./i18n";
import { INLINE, labelOf } from "./sections";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

export const nbsp = (s: string) => s.replace(UNIT, "$1\u00a0");

export function safeHref(url: string): string | undefined {
  return /^(https?|mailto|tel):/i.test(url) ? url : undefined;
}

export function anchor(url: string, inner: string, cls?: string): string {
  const href = safeHref(url);
  const c = cls ? ` class="${cls}"` : "";
  return href === undefined ? (cls ? `<span${c}>${inner}</span>` : inner) : `<a${c} href="${esc(href)}">${inner}</a>`;
}

export function md(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += nbsp(esc(s.slice(last, m.index)));
    last = m.index + m[0].length;
    const [raw, code, label, text, url, bold] = m;
    if (code !== undefined) out += `<code>${esc(code)}</code>`;
    else if (label !== undefined) {
      const t = labelOf(label);
      out += t ? `<span class="tag tag-${t.color}">${esc(t.text)}</span>` : esc(raw);
    } else if (text !== undefined) {
      const href = safeHref(url);
      out += href === undefined ? md(text) : `<a href="${esc(href)}">${md(text)}</a>`;
    } else out += `<strong>${md(bold)}</strong>`;
  }
  return out + nbsp(esc(s.slice(last)));
}

export const bareUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
