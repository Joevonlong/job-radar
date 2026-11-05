export const style = String.raw`:root { --folio-right: 15mm; }
.theme-compact {
  --ink: #16181d;
  --soft: #2e323a;
  --muted: #5d636e;
  --rule: #cfd3da;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
  font: 400 9pt/calc(1.36 * var(--lh)) "IBM Plex Sans", system-ui, sans-serif;
  color: var(--ink);
}
.theme-compact .page { padding: 12mm 15mm 11mm; }
.theme-compact strong { font-weight: 600; }
.theme-compact .sep { color: #a9aeb7; }

/* Header: name and headings are the only accent. */
.theme-compact header { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; }
.theme-compact header .id { min-width: 0; }
.theme-compact h1 { font-size: 21pt; line-height: 1.05; font-weight: 600; letter-spacing: -0.012em; word-spacing: 0.12em; color: var(--accent); }
.theme-compact .title { margin-top: 1mm; font-size: 10pt; font-weight: 500; color: var(--soft); }
.theme-compact .contact { margin-top: 1.4mm; font-size: 8.4pt; color: var(--soft); }
.theme-compact .photo { flex: none; width: 19mm; height: 25mm; object-fit: cover; border-radius: 1mm; }

/* Headings on their own line, hairline to the right edge (drawn, not text). */
.theme-compact section { margin-top: calc(3.6mm * var(--d)); }
.theme-compact h2 { display: flex; align-items: center; gap: 2.4mm; margin-bottom: calc(1.4mm * var(--d)); font-size: 8pt; line-height: 1.2; font-weight: 600; letter-spacing: 0.09em; font-kerning: none; text-transform: uppercase; color: var(--accent); }
.theme-compact h2::after { content: ""; flex: 1; height: 0.6pt; background: var(--rule); }
.theme-compact .lead { line-height: calc(1.45 * var(--lh)); }

/* Entries: one head line. */
.theme-compact .entry + .entry { margin-top: calc(2.1mm * var(--d)); }
.theme-compact .head { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.theme-compact .what { min-width: 0; }
.theme-compact .what h3 { display: inline; font-size: 9.4pt; font-weight: 600; }
.theme-compact .org { font-weight: 500; color: var(--soft); }
.theme-compact .place { color: var(--muted); }
.theme-compact .when { flex: none; font: 400 7.9pt/1 var(--mono); color: var(--muted); white-space: nowrap; }
.theme-compact .summary { margin-top: 0.3mm; color: var(--muted); }
.theme-compact .bullets { margin-top: calc(0.6mm * var(--d)); }
.theme-compact .bullets li { display: grid; grid-template-columns: 3.2mm 1fr; }
.theme-compact .bullets li + li { margin-top: calc(0.25mm * var(--d)); }
.theme-compact .bullets li::before { content: ""; width: 1mm; height: 1mm; margin: 0.58em 0 0 0.3mm; border-radius: 50%; background: #6b717c; }
.theme-compact .stack { margin-top: calc(0.5mm * var(--d)); padding-left: 3.2mm; font: 400 7.8pt/1.45 var(--mono); color: #4b515c; }

/* Plain lines: skills, certificates, languages. */
.theme-compact .lines li + li { margin-top: calc(0.3mm * var(--d)); }
.theme-compact .rows .head + .head { margin-top: calc(0.4mm * var(--d)); }
.theme-compact .rows h3 { font-weight: 500; }

/* Custom sections */
.theme-compact .custom .bullets { margin-top: 0; }
.theme-compact .custom .entry .bullets { margin-top: calc(0.6mm * var(--d)); }
.theme-compact .entry .tags { margin-top: calc(1mm * var(--d)); }
.theme-compact .tag { font-size: 0.86em; }
.theme-compact .grid .group strong { display: inline; }

@media screen and (max-width: 840px) {
  .theme-compact .page { padding: 28px 20px; }
  .theme-compact .head { flex-direction: column; gap: 2px; }
  .theme-compact header { flex-direction: column-reverse; align-items: flex-start; }
}

/* German CV fields */
.theme-compact .contact.avail { margin-top: 0.4mm; color: var(--ink); }
.theme-compact .sign { margin-top: calc(4.5mm * var(--d)); }
.theme-compact .sign-date { font: 400 7.9pt/1.3 var(--mono); }
.theme-compact .sign-name { font-size: 9.6pt; }

/* Cover letter: the resume's header over a hairline; wider margins than the dense CV (a letter is read). */
.theme-compact .page.letter { padding: 13mm 20mm 12mm 24mm; --l-fs: 10pt; --l-top: 12mm; }
.theme-compact .letter header { padding-bottom: 3.5mm; border-bottom: 0.6pt solid var(--rule); }
.theme-compact .l-date { font: 400 8.4pt/1.4 var(--mono); }
.theme-compact .l-subject { color: var(--accent); }
`;
