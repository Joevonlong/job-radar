export const style = String.raw`/* Shared by all themes: paper, pagination, print fidelity, density, screen presentation, custom-section parts. */

/* Paper. Page 1 has no margin (the theme's padding is the margin, so a one-page resume looks exactly as designed).
   Later pages keep a bottom margin for the page number; the theme's padding repeats on every page (box-decoration-break below).
   The page number is a margin box: it never enters the DOM; in the PDF text layer it sits between the pages' content. */
@page {
  size: A4;
  margin: 0 0 10mm;
  @bottom-right { content: counter(page) " / " counter(pages); vertical-align: top; padding-top: 1mm; margin-right: var(--folio-right, 16mm); font: 400 7pt/1 Inter, "IBM Plex Sans", system-ui, sans-serif; color: #8a8f99; }
}
@page :first { margin: 0; @bottom-right { content: none; } }
@page letter { size: letter; }
body[data-paper="letter"] { page: letter; }

:root { --paper-w: 210mm; --paper-h: 297mm; }
:root:has(body[data-paper="letter"]) { --paper-w: 215.9mm; --paper-h: 279.4mm; }

/* Density: themes multiply their vertical gaps by --d and their line heights by --lh. Font sizes never change. */
body { --d: 1; --lh: 1; }
body[data-density="compact"] { --d: 0.72; --lh: 0.94; }
body[data-density="relaxed"] { --d: 1.3; --lh: 1.06; }
/* meta.colors: accent: what can be clicked, and the tech stack, take the accent. Colour only — no size or
   spacing changes, so pages and the text layer stay the same. The stack is mixed with the theme's ink to stay readable. */
body[data-colors="accent"] .page a { color: var(--accent); }
body[data-colors="accent"] .page .stack, body[data-colors="accent"] .page .chips { color: color-mix(in srgb, var(--accent) 70%, var(--ink, #15171c)); }
body[data-colors="accent"] .page .stack .sep, body[data-colors="accent"] .page .chips .sep { color: color-mix(in srgb, var(--accent) 30%, white); }

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; -webkit-font-smoothing: antialiased; }
body { margin: 0; background: #e8e8eb; }
h1, h2, h3, p, ul, ol, dl, dd { margin: 0; padding: 0; }
ul, ol { list-style: none; }
a { color: inherit; text-decoration: none; }
img { display: block; }

.page {
  width: var(--paper-w);
  min-height: var(--paper-h);
  margin: 32px auto;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 12px 40px rgb(0 0 0 / 10%);
}

/* Pagination: entries may split between bullets, never inside a bullet or right after a heading. */
.page h2, .page h3, .page .head, .page .entry > .org, .page .entry > .summary { break-after: avoid; }
.page .bullets > li:first-child, .page .stack, .page .chips, .page .entry .tags { break-before: avoid; }
.page li, .page .fact, .page dt, .page dd { break-inside: avoid; }
.page p, .page li { orphans: 2; widows: 2; }

/* Visible separators between list items (certifications, languages, stack): real text, so the PDF text layer reads "a · b". */
.page .sep { color: var(--sep, #b4b8c0); }

/* Inline ${"`"}code${"`"}: mono on a light ground, never mistaken for a link. */
.page code { font: 400 0.88em/1 "IBM Plex Mono", ui-monospace, monospace; padding: 0.12em 0.2em; margin: 0 -0.2em; border-radius: 2px; background: #eef0f3; color: inherit; }

/* No position:relative/absolute on anything that carries text: Chromium paints positioned boxes in a separate layer and
   scrambles the PDF text order. Text-free decoration (e.g. split's sidebar tint) may be positioned.
   Letter-spaced text (uppercase headings) sets ${"`"}font-kerning: none${"`"}: a kerning pair (LA, TY, AV) plus letter-spacing
   leaves a gap pdf.js reads as a space, and "LANGUAGES" becomes "L ANGUAGES" in the text layer . */
:root {
  --tag-accent: var(--accent);
  --tag-blue: #2563c9;
  --tag-green: #1c7c4a;
  --tag-orange: #b85a0b;
  --tag-red: #b7352d;
  --tag-gray: #5d6370;
}
/* Tags: tinted ground plus a hairline outline, so they keep their shape in greyscale print. */
.tag { --c: var(--tag-accent); display: inline-block; padding: 0.04em 0.55em; border: 0.5pt solid color-mix(in srgb, var(--c) 40%, white); border-radius: 999px; font-size: 0.88em; font-weight: 500; line-height: 1.3; white-space: nowrap; color: var(--c); background: color-mix(in srgb, var(--c) 10%, white); }
.tag-accent { --c: var(--tag-accent); }
.tag-blue { --c: var(--tag-blue); }
.tag-green { --c: var(--tag-green); }
.tag-orange { --c: var(--tag-orange); }
.tag-red { --c: var(--tag-red); }
.tag-gray { --c: var(--tag-gray); }
.tags { display: flex; flex-wrap: wrap; gap: 1mm 0.6mm; }
.tags .ti { white-space: nowrap; }
.tags .sep { font-size: 0.9em; }

.grid { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: calc(1.6mm * var(--d)) 5mm; }
.cell { min-width: 0; }
.cell .bullets { margin-top: 0; }
.grid .group strong { display: block; }

.group + .group, .text + .text, .text + .group, .group + .text { margin-top: calc(0.8mm * var(--d)); }
.group strong { font-weight: 600; }

/* Checklist item: the box is drawn by::before (content:"" keeps it out of the PDF text layer). Done = filled accent with a white tick. */
.page .bullets li.check::before { content: ""; width: 2.5mm; height: 2.5mm; margin: 0.2em 0 0 0; border: 0.7pt solid var(--muted); border-radius: 0.6mm; background: #fff; }
.page .bullets li.check[data-done="true"]::before { border-color: var(--accent); background: var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http%3A//www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M2 5.3l2.2 2.2L8 3' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat; }

/* "Ort, Datum" + signature at the end of a resume (meta.signature): a right-aligned column of ordinary text, never
   positioned; kept on one page. Themes set the name's font. */
.page .sign { display: flex; flex-direction: column; align-items: flex-end; margin-top: calc(6mm * var(--d)); text-align: right; break-inside: avoid; }
.page .sign-date { color: var(--muted, #5f6571); }
.page .sign-img { height: 14mm; width: auto; max-width: 52mm; margin: 1.5mm 0 0.5mm; object-fit: contain; }
.page .sign-date + .sign-name { margin-top: 2.5mm; }
.page .sign-name { font-weight: 600; }

/* Cover letter, DIN 5008-inspired: letterhead (the theme's header), recipient block with "Ort, Datum" on its
   right (one flex row, DOM = reading order), bold subject without "Betreff:", salutation, paragraphs, closing,
   signature, name. Everything is ordinary text in DOM order. Themes set --l-indent (left edge of the text column),
   fonts and colours. Body copy is set larger than the resume (10.2pt): a letter is read, not scanned. */
.page.letter .l-body { font-size: var(--l-fs, 10.2pt); line-height: calc(1.5 * var(--lh)); padding-left: var(--l-indent, 0); }
.page.letter .l-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 10mm; margin-top: calc(var(--l-top, 13mm) * var(--d)); }
.page.letter .l-recipient { line-height: 1.42; }
.page.letter .l-date { margin-left: auto; white-space: nowrap; color: var(--muted, #5f6571); }
.page.letter .l-subject { margin-top: calc(11mm * var(--d)); font-weight: 600; }
.page.letter .l-salutation { margin-top: calc(6.5mm * var(--d)); }
.page.letter .l-text { margin-top: calc(3.2mm * var(--d)); }
.page.letter .l-text p + p { margin-top: calc(3.2mm * var(--d)); }
.page.letter .l-sign { margin-top: calc(5mm * var(--d)); break-inside: avoid; }
.page.letter .l-sig { display: block; height: 15mm; width: auto; max-width: 55mm; margin: 1.5mm 0 0.5mm -1mm; object-fit: contain; }
/* No image: room for a handwritten signature on the printout. */
.page.letter .l-closing + .l-signer { margin-top: 13mm; }
/* DIN fold marks (105 / 210 mm) and the hole mark (148.5 mm): text-free hairlines on the left edge, A4 only. */
body[data-doc="letter"][data-paper="a4"] .page.letter {
  background-image: linear-gradient(#c3c7ce, #c3c7ce), linear-gradient(#c3c7ce, #c3c7ce), linear-gradient(#c3c7ce, #c3c7ce);
  background-repeat: no-repeat;
  background-size: 4mm 0.5pt, 6mm 0.5pt, 4mm 0.5pt;
  background-position: 0 105mm, 0 148.5mm, 0 210mm;
}

/* Text-free chevron drawn with borders (a "›" glyph would end up in the PDF text layer). */
.chev { display: inline-block; width: 0.34em; height: 0.34em; margin: 0 0.5em 0.12em 0.05em; border: solid currentColor; border-width: 0.1em 0.1em 0 0; transform: rotate(45deg); }

@media print {
  body { background: none; }
  .page { margin: 0; box-shadow: none; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
}

/* Web version on narrow screens: drop the sheet metaphor. */
@media screen and (max-width: 840px) {
  body { background: #fff; }
  .page { width: auto; min-height: 0; margin: 0; box-shadow: none; }
}
`;
