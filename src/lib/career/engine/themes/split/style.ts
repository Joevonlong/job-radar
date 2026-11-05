export const style = String.raw`:root { --folio-right: 13mm; }
.theme-split {
  --ink: #14161b;
  --muted: #5b616e;
  --rule: #dfe2e8;
  --tint: color-mix(in srgb, var(--accent) 5%, #fafbfc);
  --mono: "IBM Plex Mono", ui-monospace, monospace;
  --side: 64mm;
  font: 400 9.2pt/calc(1.38 * var(--lh)) "IBM Plex Sans", system-ui, sans-serif;
  color: var(--ink);
}
/* The main column is first in the DOM (name first in the PDF text layer); grid areas draw the sidebar on the left. */
.theme-split .page { display: grid; grid-template-columns: var(--side) minmax(0, 1fr); grid-template-areas: "aside main"; }
.theme-split .main { grid-area: main; }
.theme-split aside { grid-area: aside; }
.theme-split strong { font-weight: 600; }
.theme-split .mono { font-family: var(--mono); font-size: 7.8pt; color: var(--muted); }
.theme-split .muted { color: var(--muted); }

/* Section headings: mono label + hairline */
.theme-split h2 { display: flex; align-items: center; gap: 2.5mm; font: 500 7.6pt/1.2 var(--mono); letter-spacing: 0.09em; font-kerning: none; text-transform: uppercase; color: var(--accent); margin-bottom: calc(2.2mm * var(--d)); }
.theme-split h2::after { content: ""; flex: 1; height: 0.5pt; background: var(--rule); }
.theme-split section + section { margin-top: calc(4mm * var(--d)); }

/* Sidebar */
.theme-split aside { background: var(--tint); padding: 15mm 7mm 13mm 11mm; border-right: 0.5pt solid var(--rule); font-size: 8.5pt; }
.theme-split .photo { width: 30mm; height: 40mm; object-fit: cover; border-radius: 1.5mm; margin-bottom: 6mm; }
/* Long links wrap only after a "/" (urlText: <wbr> between nowrap segments), never at a "-" inside a segment. */
.theme-split .contact li { overflow-wrap: break-word; }
.theme-split .contact .seg { white-space: nowrap; }
.theme-split .contact li + li { margin-top: calc(0.7mm * var(--d)); }
.theme-split .contact a { border-bottom: 0.5pt solid var(--rule); }
.theme-split .contact .auth { font-weight: 500; }
.theme-split aside h3 { font-size: 8.8pt; font-weight: 600; }
.theme-split .skill + .skill { margin-top: calc(2.2mm * var(--d)); }
.theme-split .skill h3 { margin-bottom: 0.9mm; }
.theme-split .fact + .fact { margin-top: calc(2.2mm * var(--d)); }
.theme-split .fact .org { margin-top: 0; font-weight: 500; color: var(--ink); }
.theme-split .langs { display: grid; grid-template-columns: auto 1fr; gap: calc(0.7mm * var(--d)) 3mm; }
.theme-split .langs dt { font-weight: 600; }
.theme-split .langs dd { color: var(--muted); }

/* Chips: the stack, set in mono. The "·" between them is real (light) text. */
.theme-split .chips { display: flex; flex-wrap: wrap; align-items: center; row-gap: 1mm; font: 400 7.6pt/1 var(--mono); color: #3a3f4a; --sep: color-mix(in srgb, var(--accent) 25%, #c4c8cf); }
.theme-split .unit { display: inline-flex; align-items: center; white-space: nowrap; }
.theme-split .chip { padding: 0.8mm 1.3mm; border: 0.5pt solid #d3d7de; border-radius: 2px; background: #fff; }
.theme-split .chips .sep { padding: 0 0.7mm; font-size: 7pt; }
.theme-split .skill p { line-height: calc(1.4 * var(--lh)); }
.theme-split .entry .chips { margin-top: calc(1.3mm * var(--d)); }
.theme-split .entry .chip { background: var(--tint); border-color: color-mix(in srgb, var(--accent) 14%, #e3e6eb); }

/* Main column */
.theme-split .main { padding: 15mm 13mm 13mm 10mm; }
.theme-split header { margin-bottom: calc(5mm * var(--d)); }
.theme-split h1 { font-size: 25pt; line-height: 1; font-weight: 600; letter-spacing: -0.02em; word-spacing: 0.12em; }
.theme-split .title { margin-top: 2.2mm; font: 500 9.4pt/1.2 var(--mono); color: var(--accent); }
.theme-split .title .chev { color: color-mix(in srgb, var(--accent) 55%, white); }
.theme-split .lead { margin-top: 3.2mm; font-size: 9.5pt; line-height: calc(1.48 * var(--lh)); color: #2b2f37; }

.theme-split .approach { display: grid; gap: calc(1.6mm * var(--d)); }
.theme-split .approach li { display: grid; grid-template-columns: 6mm 1fr; }
.theme-split .approach .n { font: 500 7.8pt/1.7 var(--mono); color: var(--accent); }
.theme-split .approach h3 { display: inline; font-size: 9.2pt; font-weight: 600; }
.theme-split .approach p { display: inline; color: var(--muted); }
.theme-split .approach h3::after { content: " —"; color: #b9bec7; font-weight: 400; }

.theme-split .entry + .entry { margin-top: calc(3mm * var(--d)); }
.theme-split .head { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.theme-split .head h3 { font-size: 9.8pt; font-weight: 600; }
.theme-split .head .mono { flex: none; }
/* Organisation: accent colour and weight 600, so it still stands out in greyscale. */
.theme-split .org { font-weight: 600; color: var(--accent); margin-top: 0.2mm; }
.theme-split .org .muted { font-weight: 500; }
.theme-split .bullets { margin-top: calc(1mm * var(--d)); }
.theme-split .bullets li { display: grid; grid-template-columns: 3.4mm 1fr; }
.theme-split .bullets li + li { margin-top: calc(0.4mm * var(--d)); }
.theme-split .bullets li::before { content: ""; width: 1.1mm; height: 1.1mm; margin: 0.52em 0 0 0.3mm; border: solid var(--accent); border-width: 0.7pt 0.7pt 0 0; transform: rotate(45deg); }

/* Custom sections */
.theme-split .bullets li.check::before { width: 2.5mm; height: 2.5mm; margin: 0.2em 0 0 0; border-width: 0.7pt; border-color: var(--muted); transform: none; }
.theme-split .bullets li.check[data-done="true"]::before { border-color: var(--accent); }
.theme-split .tag { font-family: var(--mono); font-size: 0.8em; font-weight: 500; }
.theme-split .entry .tags { margin-top: calc(1.4mm * var(--d)); }
.theme-split .custom .tags { margin-top: 0; }
.theme-split .custom .entry .tags { margin-top: calc(1.4mm * var(--d)); }
.theme-split .custom .bullets { margin-top: 0; }
.theme-split .custom .entry .bullets { margin-top: calc(1mm * var(--d)); }
.theme-split aside .custom .grid { gap: 1.4mm 3mm; }

/* Print: the sidebar tint is one text-free fixed layer, so it fills every page top to bottom (including the folio margin
   of later pages, via the bottom-left margin box). Both columns repeat their padding on each page. */
@media print {
  .theme-split .page { background: transparent; }
  .theme-split aside { background: none; border-right: 0; }
  body.theme-split::before { content: ""; position: fixed; top: 0; bottom: 0; left: 0; width: var(--side); background: var(--tint); border-right: 0.5pt solid var(--rule); z-index: -1; }
  .theme-split .main, .theme-split aside { box-decoration-break: clone; -webkit-box-decoration-break: clone; }
}
@page { @bottom-left { content: ""; box-sizing: border-box; width: 64mm; background: color-mix(in srgb, var(--accent) 5%, #fafbfc); border-right: 0.5pt solid #dfe2e8; } }
@page :first { @bottom-left { content: none; } }

@media screen and (max-width: 840px) {
  .theme-split .page { grid-template-columns: 1fr; grid-template-areas: "main" "aside"; }
  .theme-split aside { padding: 24px 20px; border-right: 0; }
  .theme-split .main { padding: 28px 20px; }
  .theme-split .head { flex-direction: column; gap: 2px; }
}

/* German CV fields  */
.theme-split .contact .addr { line-height: 1.42; }
.theme-split .contact .avail { font-weight: 500; }
.theme-split .sign { margin-top: calc(7mm * var(--d)); }
.theme-split .sign-date { font: 400 7.8pt/1.3 var(--mono); }
.theme-split .sign-name { font-size: 10pt; }

/* Cover letter: one column. The sidebar survives as a tinted strip with its hairline on the left edge
   (background only, no text); the letterhead is the main column's header plus one mono contact line. */
body.theme-split[data-doc="letter"]::before { content: none; }
.theme-split .page.letter { display: block; padding: 16mm 18mm 13mm 30mm; --l-indent: 0; --l-top: 12mm; }
body.theme-split[data-doc="letter"] .page.letter {
  background-color: #fff;
  background-image: linear-gradient(to right, var(--tint) 0 14mm, var(--rule) 14mm calc(14mm + 0.6pt), transparent calc(14mm + 0.6pt));
}
body.theme-split[data-doc="letter"][data-paper="a4"] .page.letter {
  background-image: linear-gradient(#b9bec7, #b9bec7), linear-gradient(#b9bec7, #b9bec7), linear-gradient(#b9bec7, #b9bec7),
    linear-gradient(to right, var(--tint) 0 14mm, var(--rule) 14mm calc(14mm + 0.6pt), transparent calc(14mm + 0.6pt));
  background-repeat: no-repeat;
  background-size: 4mm 0.5pt, 6mm 0.5pt, 4mm 0.5pt, 100% 100%;
  background-position: 0 105mm, 0 148.5mm, 0 210mm, 0 0;
}
.theme-split .letter header { margin-bottom: 0; padding-bottom: 4.5mm; border-bottom: 0.5pt solid var(--rule); }
.theme-split .letter .contact { margin-top: 3mm; font: 400 7.9pt/1.5 var(--mono); color: var(--muted); }
.theme-split .letter .contact + .contact { margin-top: 0.4mm; }
.theme-split .letter .contact a { border-bottom: 0.5pt solid var(--rule); }
.theme-split .letter .contact .sep { padding: 0 0.3mm; }
.theme-split .l-body { font-size: 10pt; }
.theme-split .l-date { font: 400 8.4pt/1.4 var(--mono); }
.theme-split .l-subject { font-size: 10.6pt; }
.theme-split .l-subject::before { content: ""; display: inline-block; width: 1.6mm; height: 1.6mm; margin: 0 2.4mm 0.35mm 0; border: solid var(--accent); border-width: 0.8pt 0.8pt 0 0; transform: rotate(45deg); }
.theme-split .l-signer { font-size: 10.4pt; }
`;
