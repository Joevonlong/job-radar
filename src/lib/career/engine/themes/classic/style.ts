export const style = String.raw`:root { --folio-right: 16mm; }
.theme-classic {
  --ink: #1a1a1a;
  --soft: #333;
  --muted: #616161;
  --rule: #d6d6d6;
  --col: 30mm;
  --serif: Newsreader, Georgia, serif;
  font: 400 9.2pt/calc(1.38 * var(--lh)) Inter, system-ui, sans-serif;
  color: var(--ink);
}
.theme-classic .page { padding: 13mm 16mm 11mm; }
.theme-classic strong { font-weight: 600; }
.theme-classic .sep { color: #a8a8a8; }

/* Header: name with the contact block top right (letterhead), title under the name across the page; portrait far right. */
.theme-classic header { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name contact" "title title"; column-gap: 6mm; align-items: end; }
.theme-classic header.with-photo { grid-template-columns: minmax(0, 1fr) 30mm; grid-template-areas: "name photo" "title photo" "contact photo"; grid-template-rows: auto auto 1fr; align-items: start; }
.theme-classic header.with-photo h1 { padding-top: 3mm; }
.theme-classic header.with-photo .contact { max-width: none; margin-top: 2.6mm; text-align: left; }
.theme-classic h1 { grid-area: name; font: 500 26pt/1.05 var(--serif); letter-spacing: -0.01em; word-spacing: 0.12em; font-variation-settings: "opsz" 72; }
.theme-classic .title { grid-area: title; margin-top: 1.4mm; font-size: 10.5pt; font-weight: 500; color: var(--soft); }
.theme-classic .contact { grid-area: contact; max-width: 95mm; text-align: right; font-size: 8.4pt; line-height: 1.5; color: var(--soft); }
.theme-classic .contact .seg { white-space: nowrap; }
.theme-classic .photo { grid-area: photo; align-self: start; width: 30mm; height: 40mm; object-fit: cover; border: 0.5pt solid #c8c8c8; }

/* Headings: serif, own line, accent hairline underneath (the only accent on the page). */
.theme-classic section { margin-top: calc(2.3mm * var(--d)); }
.theme-classic h2 { font: 600 11.5pt/1.15 var(--serif); padding-bottom: 0.4mm; border-bottom: 0.75pt solid var(--accent); margin-bottom: calc(1.4mm * var(--d)); }
.theme-classic .lead { line-height: calc(1.48 * var(--lh)); }

/* Rows: dates or labels left, details right. */
.theme-classic .row { display: grid; grid-template-columns: var(--col) minmax(0, 1fr); column-gap: 5mm; }
.theme-classic .row + .row { margin-top: calc(2mm * var(--d)); }
.theme-classic .table .row + .row, .theme-classic .fact + .fact { margin-top: calc(0.7mm * var(--d)); }
/* Skill and language labels may outgrow the date column ("Programmiersprachen"): that table widens instead of overlapping. */
.theme-classic .table { display: grid; grid-template-columns: minmax(var(--col), max-content) minmax(0, 1fr); column-gap: 5mm; }
.theme-classic .table .row { display: contents; }
.theme-classic .table .row + .row > * { padding-top: calc(0.7mm * var(--d)); }
.theme-classic .when { display: block; font-size: 8.4pt; color: var(--soft); font-variant-numeric: tabular-nums; white-space: nowrap; }
.theme-classic .where { display: block; font-size: 8pt; color: var(--muted); }
.theme-classic .row > .l { padding-top: 0.3mm; }
.theme-classic .table .l { padding-top: 0; }
.theme-classic .link { margin-top: 0.2mm; font-size: 8pt; color: var(--muted); break-after: avoid; }
.theme-classic .link .seg { white-space: nowrap; }
.theme-classic .label { font-weight: 600; }
.theme-classic h3 { font-size: 9.7pt; font-weight: 600; }
.theme-classic .org { font-weight: 500; color: var(--soft); }
.theme-classic .approach li + li { margin-top: calc(0.6mm * var(--d)); }
.theme-classic .place { color: var(--muted); }
.theme-classic .cert { font-weight: 500; }
.theme-classic .summary { margin-top: 0.4mm; color: var(--muted); }
.theme-classic .bullets { margin-top: calc(0.9mm * var(--d)); }
.theme-classic .bullets li { display: grid; grid-template-columns: 3.6mm 1fr; }
.theme-classic .bullets li + li { margin-top: calc(0.35mm * var(--d)); }
.theme-classic .bullets li::before { content: ""; width: 1.8mm; height: 0.6pt; margin: 0.7em 0 0 0.2mm; background: #6f6f6f; }
.theme-classic .stack { margin-top: calc(0.6mm * var(--d)); padding-left: 3.6mm; font-size: 8.4pt; color: var(--muted); }

/* Custom sections */
.theme-classic .custom .bullets { margin-top: 0; }
.theme-classic .custom .entry .bullets { margin-top: calc(0.9mm * var(--d)); }
.theme-classic .entry .tags { margin-top: calc(1.1mm * var(--d)); }
.theme-classic .tag { font-size: 0.86em; }

@media screen and (max-width: 840px) {
  .theme-classic .page { padding: 28px 20px; }
  .theme-classic .row, .theme-classic .table { grid-template-columns: 1fr; }
  .theme-classic header, .theme-classic header.with-photo { grid-template-columns: 1fr; grid-template-areas: "photo" "name" "title" "contact"; }
  .theme-classic .contact { text-align: left; margin-top: 8px; }
}
.theme-classic .langs .sep { margin: 0 0.35em; }

/* German CV fields: the traditional close — "Ort, Datum", signature, name in the heading serif. */
.theme-classic .contact .avail { color: var(--ink); font-weight: 500; }
.theme-classic .sign { margin-top: calc(5mm * var(--d)); }
.theme-classic .sign-name { font: 600 11.5pt/1.15 var(--serif); }

/* Cover letter: the letterhead (name left, address block right) over the accent hairline; serif subject
   and signed name — the theme's traditional voice. DIN-like margins. */
.theme-classic .page.letter { padding: 14mm 20mm 12mm 25mm; --l-top: 12mm; }
.theme-classic .letter header { padding-bottom: 3.2mm; border-bottom: 0.75pt solid var(--accent); }
.theme-classic .l-subject { font: 600 12pt/1.3 var(--serif); }
.theme-classic .l-signer { font: 600 11.5pt/1.15 var(--serif); }
`;
