import { homeCity } from "./i18n";
import { letterParts } from "./letter";
import { esc, md } from "./md";
import type { Resume } from "./schema";
import type { Item, Section, Tag } from "./sections";
import type { Ctx } from "./theme";

type Entry = Extract<Item, { kind: "entry" }>;
type Custom = Extract<Section, { kind: "custom" }>;

export interface Kit {
  bullets(xs: string[]): string;
  entry(e: Entry): string;
}

export function tags(ts: Tag[]): string {
  const unit = (t: Tag, i: number) => `<span class="ti"><span class="tag tag-${t.color}">${esc(t.text)}</span>${i < ts.length - 1 ? '<span class="sep">&nbsp;·</span>' : ""}</span>`;
  return ts.length ? `<p class="tags">${ts.map(unit).join(" ")}</p>` : "";
}

export const joinSep = (parts: (string | false | undefined)[], sep = "·") =>
  parts.filter(Boolean).join(`<span class="sep">&nbsp;${sep} </span>`);

export const urlText = (display: string) =>
  display
    .split(/(?<=\/)/)
    .map((seg) => `<span class="seg">${esc(seg)}</span>`)
    .join("<wbr>");

const group = (g: Extract<Item, { kind: "group" }>) => `<p class="group"><strong>${esc(g.label)}:</strong> ${g.items.map(esc).join(", ")}</p>`;

function list(items: Item[], kit: Kit): string {
  const lis = items.filter((it) => it.kind === "bullet" || it.kind === "check");
  if (lis.every((it) => it.kind === "bullet")) return kit.bullets(lis.map((it) => it.text));
  return `<ul class="bullets">${lis
    .map((it) => (it.kind === "check" ? `<li class="check" data-done="${it.done}"><span>${md(it.text)}</span></li>` : `<li><span>${md(it.text)}</span></li>`))
    .join("")}</ul>`;
}

function one(it: Item, kit: Kit): string {
  switch (it.kind) {
    case "bullet":
    case "check":
      return list([it], kit);
    case "group":
      return group(it);
    case "text":
      return `<p class="text">${md(it.text)}</p>`;
    case "entry":
      return kit.entry(it);
    case "tag":
      return tags([it.tag]);
  }
}

export function customBody(s: Custom, kit: Kit): string {
  if (s.layout === "tags") return tags(s.items.flatMap((it) => (it.kind === "tag" ? [it.tag] : [])));
  if (s.layout === "grid") return `<div class="grid" style="--cols:${s.columns}">${s.items.map((it) => `<div class="cell">${one(it, kit)}</div>`).join("")}</div>`;
  const first = s.items[0];
  if (first.kind === "bullet" || first.kind === "check") return list(s.items, kit);
  return s.items.map((it) => one(it, kit)).join("");
}

export const placeLine = (b: Resume["basics"]) => (b.address ? b.address.join(", ") : b.location);

export function signDate(r: Resume, ctx: Pick<Ctx, "placeDate" | "today">): string | undefined {
  const s = r.meta.signature;
  if (!s) return undefined;
  return ctx.placeDate(s.place ?? homeCity(r.basics), s.date === "auto" ? ctx.today : s.date);
}

export function letterBody(r: Resume, ctx: Ctx): string {
  const l = letterParts(r, ctx.today);
  const recipient = l.recipient.length ? `<div class="l-recipient">${l.recipient.map((x) => `<p>${esc(x)}</p>`).join("")}</div>` : "";
  return `<div class="l-body">
<div class="l-head">${recipient}<p class="l-date">${esc(l.placeDate)}</p></div>
${l.subject ? `<p class="l-subject">${md(l.subject)}</p>\n` : ""}<p class="l-salutation">${esc(l.salutation)}</p>
<div class="l-text">${l.body.map((p) => `<p>${md(p)}</p>`).join("\n")}</div>
<div class="l-sign">
  <p class="l-closing">${esc(l.closing)}</p>
  ${ctx.signatureUrl ? `<img class="l-sig" src="${ctx.signatureUrl}" alt="">` : ""}
  <p class="l-signer">${esc(l.signer)}</p>
</div>
</div>`;
}

export function letterHtml(r: Resume, ctx: Ctx): string {
  const b = r.basics;
  const contact = joinSep([placeLine(b) && esc(placeLine(b)!), b.phone && esc(b.phone), b.email && esc(b.email)]);
  return `<main class="page letter">
<header class="l-letterhead"><h1>${esc(b.name)}</h1><p class="title">${esc(b.title)}</p>${contact ? `<p class="contact">${contact}</p>` : ""}</header>
${letterBody(r, ctx)}
</main>`;
}

export function signOff(r: Resume, ctx: Ctx): string {
  const line = signDate(r, ctx);
  if (!line) return "";
  return `<div class="sign">
  <p class="sign-date">${esc(line)}</p>
  ${ctx.signatureUrl ? `<img class="sign-img" src="${ctx.signatureUrl}" alt="">` : ""}
  <p class="sign-name">${esc(r.basics.name)}</p>
</div>`;
}
