export const style = String.raw`/* Later pages: a little top margin on top of the content's repeated padding (the band is on page 1 only). */
@page { margin-top: 6mm; }
@page :first { margin-top: 0; }
:root { --folio-right: 16mm; }
.theme-band {
  --ink: #15171c;
  --muted: #5d636f;
  --rule: #e1e4ea;
  /* The band is the accent pulled slightly towards ink: white text stays readable for light accents and in greyscale. */
  --band: color-mix(in srgb, var(--accent) 84%, #0b1020);
  font: 400 9.2pt/calc(1.37 * var(--lh)) Inter, system-ui, sans-serif;
  color: var(--ink);
}
.theme-band strong { font-weight: 600; }
.theme-band .muted { color: var(--muted); }

/* Band: plain block with a background (no positioning), full bleed. */
.theme-band .band { display: flex; justify-content: space-between; align-items: center; gap: 8mm; padding: 9mm 16mm 6.5mm; background: var(--band); color: #fff; }
.theme-band .band .id { min-width: 0; }
body[data-colors="accent"].theme-band .band a { color: inherit; } /*: the band is the accent already */
.theme-band h1 { font-size: 24pt; line-height: 1.05; font-weight: 700; letter-spacing: -0.02em; word-spacing: 0.12em; }
.theme-band .title { margin-top: 1.6mm; font-size: 10.5pt; font-weight: 500; color: color-mix(in srgb, #fff 84%, var(--band)); }
.theme-band .contact { margin-top: 2.6mm; font-size: 8.4pt; color: color-mix(in srgb, #fff 90%, var(--band)); }
.theme-band .contact + .contact { margin-top: 0.5mm; }
.theme-band .contact .sep { color: color-mix(in srgb, #fff 50%, var(--band)); }
.theme-band .photo { flex: none; width: 23mm; height: 30mm; object-fit: cover; border-radius: 1.2mm; border: 1pt solid color-mix(in srgb, #fff 70%, var(--band)); }

.theme-band .content { padding: 5mm 16mm 10mm; }

/* Headings: own line, short accent bar on the left (a border, not text). */
.theme-band section + section { margin-top: calc(3mm * var(--d)); }
.theme-band h2 { margin-bottom: calc(1.4mm * var(--d)); padding-left: 2.2mm; border-left: 3pt solid var(--accent); font-size: 8.3pt; line-height: 1.15; font-weight: 700; letter-spacing: 0.09em; font-kerning: none; text-transform: uppercase; }
.theme-band .lead { font-size: 9.5pt; line-height: calc(1.48 * var(--lh)); }

/* Entries */
.theme-band .entry + .entry { margin-top: calc(2.3mm * var(--d)); }
.theme-band .head { display: flex; justify-content: space-between; align-items: baseline; gap: 5mm; }
.theme-band h3 { font-size: 9.8pt; font-weight: 600; }
.theme-band .when { flex: none; font-size: 8.3pt; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Organisation: weight 600 and accent, so it still stands out in greyscale. */
.theme-band .what { min-width: 0; }
.theme-band .what h3 { display: inline; }
.theme-band .what .sep { color: #b3b8c1; }
.theme-band .what .name { font-weight: 600; color: var(--accent); }
.theme-band .what .place { color: var(--muted); }
.theme-band .summary { margin-top: 0.4mm; color: var(--muted); }
.theme-band .bullets { margin-top: calc(0.8mm * var(--d)); }
.theme-band .bullets li { display: grid; grid-template-columns: 3.6mm 1fr; }
.theme-band .bullets li + li { margin-top: calc(0.4mm * var(--d)); }
.theme-band .bullets li::before { content: ""; width: 1.1mm; height: 1.1mm; margin: 0.55em 0 0 0.2mm; border-radius: 0.2mm; background: var(--accent); }
.theme-band .stack { margin-top: calc(0.8mm * var(--d)); padding-left: 3.6mm; font: 400 7.8pt/1.45 "IBM Plex Mono", ui-monospace, monospace; color: #4a505b; }

/* Approach: three columns */
.theme-band .approach { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm; }
.theme-band .approach li { display: grid; grid-template-columns: 6mm 1fr; }
.theme-band .approach .n { font: 400 8pt/1.55 "IBM Plex Mono", monospace; color: var(--accent); }
.theme-band .approach h3 { font-size: 9pt; }
.theme-band .approach p { margin-top: 0.3mm; font-size: 8.5pt; line-height: calc(1.4 * var(--lh)); color: var(--muted); }

/* Skills, certificates, languages */
.theme-band .skills { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 5mm; row-gap: calc(0.6mm * var(--d)); }
.theme-band .skills dt, .theme-band .fact { font-weight: 600; }
.theme-band .facts li + li { margin-top: calc(0.5mm * var(--d)); }
.theme-band .langs .sep { margin: 0 0.4em; }

/* Custom sections */
.theme-band .custom .bullets { margin-top: 0; }
.theme-band .custom .entry .bullets { margin-top: calc(0.8mm * var(--d)); }
.theme-band .entry .tags { margin-top: calc(1.2mm * var(--d)); }
.theme-band .tag { font-size: 0.86em; }

@media print {
  .theme-band .content { box-decoration-break: clone; -webkit-box-decoration-break: clone; }
}
@media screen and (max-width: 840px) {
  .theme-band .band { padding: 28px 20px; flex-direction: column-reverse; align-items: flex-start; }
  .theme-band .content { padding: 20px; }
  .theme-band .approach { grid-template-columns: 1fr; }
  .theme-band .head { flex-direction: column; gap: 2px; }
}

/* German CV fields  */
.theme-band .contact .avail { color: #fff; font-weight: 500; }
.theme-band .sign { margin-top: calc(6mm * var(--d)); }
.theme-band .sign-name { font-size: 9.8pt; }

/* Cover letter: the same band (aligned with the letter's margins), the subject with the theme's accent bar. */
.theme-band .letter .band { padding: 9mm 20mm 6.5mm 25mm; }
.theme-band .letter .content { padding: 0 20mm 10mm 25mm; }
.theme-band .page.letter { --l-top: 13mm; }
.theme-band .l-subject { padding-left: 2.4mm; border-left: 3pt solid var(--accent); line-height: 1.35; }
`;
