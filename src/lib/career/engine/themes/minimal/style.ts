export const style = String.raw`.theme-minimal {
  --ink: #15171c;
  --muted: #5f6571;
  --rule: #e2e4e9;
  --label: 34mm;
  font: 400 9.2pt/calc(1.4 * var(--lh)) Inter, system-ui, sans-serif;
  color: var(--ink);
}
/* German labels (BERUFSERFAHRUNG) are longer: keep at least 3 mm between label and text. */
.theme-minimal:lang(de) { --label: 36mm; }
.theme-minimal .page { padding: 13mm 16mm 11mm; }
.theme-minimal i { font-style: normal; color: #c3c7ce; margin: 0 0.55em; }
.theme-minimal strong { font-weight: 600; }
.theme-minimal .muted { color: var(--muted); }

/* Header */
.theme-minimal header { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; padding-bottom: calc(3.6mm * var(--d)); border-bottom: 0.75pt solid var(--ink); margin-bottom: calc(1mm * var(--d)); }
.theme-minimal h1 { font: 500 29pt/1 Newsreader, Georgia, serif; letter-spacing: -0.015em; word-spacing: 0.12em; font-variation-settings: "opsz" 72; }
.theme-minimal .title { margin-top: 2mm; font-size: 10.5pt; font-weight: 500; color: var(--accent); letter-spacing: 0.005em; }
.theme-minimal .title .chev { color: color-mix(in srgb, var(--accent) 55%, white); }
.theme-minimal .contact .auth { color: var(--ink); white-space: nowrap; }
.theme-minimal .contact { margin-top: 2.4mm; font-size: 8.3pt; color: var(--muted); }
.theme-minimal .contact a:hover { color: var(--accent); }
.theme-minimal .contact span { white-space: nowrap; }
.theme-minimal .contact + .contact { margin-top: 0.5mm; }
.theme-minimal header .id { min-width: 0; }
/* German Lebenslauf convention: a 3:4 portrait, slightly rounded. */
.theme-minimal .photo { flex: none; width: 24mm; height: 32mm; object-fit: cover; border-radius: 1.5mm; }

/* Sections: label column + content column */
.theme-minimal section { display: grid; grid-template-columns: var(--label) minmax(0, 1fr); padding: calc(2.6mm * var(--d)) 0; }
.theme-minimal section + section { border-top: 0.5pt solid var(--rule); }
.theme-minimal h2 { font-size: 7.6pt; line-height: 1.5; font-weight: 600; letter-spacing: 0.09em; font-kerning: none; text-transform: uppercase; color: var(--accent); padding-top: 0.5mm; padding-right: 2.5mm; overflow-wrap: break-word; }
.theme-minimal .lead { font-size: 9.6pt; line-height: calc(1.48 * var(--lh)); }

/* Entries */
.theme-minimal .entry + .entry { margin-top: calc(2.6mm * var(--d)); }
.theme-minimal .head { display: flex; justify-content: space-between; align-items: baseline; gap: 5mm; }
.theme-minimal h3 { font-size: 9.6pt; font-weight: 600; }
/* Company / tagline: inline-block, so a name that doesn't fit the line moves down whole instead of leaving an orphan word behind the role.
   The "— " in front is glued to the role (nbsp in the template), so a company that moves down starts its line without a dash. */
.theme-minimal .org { display: inline-block; max-width: 100%; vertical-align: top; font-weight: 500; color: var(--muted); }
.theme-minimal .dash { font-weight: 400; color: #c3c7ce; }
.theme-minimal .meta { flex: none; font-size: 8.2pt; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.theme-minimal .meta .where { color: #7b818c; }
.theme-minimal .summary { margin-top: 0.4mm; color: var(--muted); }
.theme-minimal .bullets { margin-top: calc(0.8mm * var(--d)); }
.theme-minimal .bullets li { display: grid; grid-template-columns: 3.6mm 1fr; }
.theme-minimal .bullets li + li { margin-top: calc(0.4mm * var(--d)); }
.theme-minimal .bullets li::before { content: ""; margin: 0.68em 0 0 0.4mm; width: 1.6mm; height: 0.6pt; background: var(--muted); }
.theme-minimal .stack { margin-top: calc(0.9mm * var(--d)); padding-left: 3.6mm; font: 400 7.8pt/1.45 "IBM Plex Mono", ui-monospace, monospace; color: #4a505b; }
.theme-minimal .stack .sep { color: #b4b9c2; }

/* Custom sections */
.theme-minimal .custom .body > .bullets:first-child, .theme-minimal .custom .body > .group:first-child, .theme-minimal .custom .body > .text:first-child { margin-top: 0; }
.theme-minimal .custom .bullets { margin-top: 0; }
.theme-minimal .custom .entry .bullets { margin-top: calc(0.8mm * var(--d)); }
.theme-minimal .tag { font-size: 0.86em; }
.theme-minimal .entry .tags { margin-top: calc(1.2mm * var(--d)); }
.theme-minimal .grid .cell .bullets li { grid-template-columns: 3.6mm 1fr; }

/* Approach: three quiet columns with an accent hairline */
.theme-minimal .approach { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; counter-reset: a; }
.theme-minimal .approach li { border-left: 1.2pt solid var(--accent); padding-left: 2.6mm; counter-increment: a; }
.theme-minimal .approach h3 { font-size: 8.9pt; }
.theme-minimal .approach h3::before { content: "0" counter(a) "  "; color: var(--accent); font-variant-numeric: tabular-nums; white-space: pre; }
.theme-minimal .approach p { margin-top: 0.4mm; font-size: 8.5pt; line-height: calc(1.4 * var(--lh)); color: var(--muted); }

/* Skills & short lists. The label column fits its longest label (German "Programmiersprachen" included). */
.theme-minimal .skills { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 5mm; row-gap: calc(0.6mm * var(--d)); }
.theme-minimal .skills dt { font-weight: 600; }
.theme-minimal .certs li + li { margin-top: calc(0.5mm * var(--d)); }
.theme-minimal .langs .sep { margin: 0 0.5em; }

@media screen and (max-width: 840px) {
  .theme-minimal .page { padding: 28px 20px; }
  .theme-minimal section { grid-template-columns: 1fr; gap: 8px; }
  .theme-minimal .approach { grid-template-columns: 1fr; }
  .theme-minimal .head { flex-direction: column; gap: 2px; }
  .theme-minimal .meta { white-space: normal; }
  .theme-minimal header { flex-direction: column-reverse; align-items: flex-start; }
}

/* German CV fields: availability reads like the work-authorization line; the signed name in the display serif. */
.theme-minimal .contact.avail { color: var(--ink); }
.theme-minimal .sign-name { font: 500 12.5pt/1.1 Newsreader, Georgia, serif; font-variation-settings: "opsz" 24; }

/* Cover letter: the resume's header; the letter sits in the content column, right of the label column. */
.theme-minimal .page.letter { --l-indent: var(--label); padding-bottom: 12mm; }
.theme-minimal .l-subject { font-size: 10.8pt; }
.theme-minimal .l-signer { font: 500 12.5pt/1.1 Newsreader, Georgia, serif; font-variation-settings: "opsz" 24; }
`;
