# Job information extraction rules

The processing pipeline (the `pipeline` step) reads a few facts out of the JD text. The word lists and thresholds are all in `pipeline.yaml` (a shipped file: copy `config/pipeline.yaml` to `data/config/pipeline.yaml` and edit your copy); after changing them, use `pnpm reprocess` to make jobs already in the database be re-read under the new rules (the collected original text is not touched). The principle stays the same: whatever the JD does not say is `unknown`; nothing is guessed.

## Work arrangement (`workplace`)

If the source supplies a value, the source's value is used; only when the source gives none (`unknown`) is the text read, with the rules in the `workplace` section:

- `head`: the title, the location text and the contract hint are each matched separately, fairly loosely ("(Remote)", "Berlin (Onsite)", "Hybrid – Munich"). If only one arrangement appears, it is used.
- `text`: the description body, strict ("hybrid work model", "3 days in the office", "Home Office möglich", "100% remote", `#LI-Hybrid`). "Remote Working Furniture", "home office stipend" and "100% remote work option during pregnancy" in a benefits list do not count.
- `negation_patterns`: a hit preceded by a negation in the same sentence ("not available as fully remote", "we do not offer remote-only roles") does not count.
- If two or more arrangements appear in the same place ("remote or hybrid"), it stays `unknown`; no side is picked.
- Labelled or bracketed forms also count: `Location: Berlin - On-site`, `Deutschlandweit (Hybrid)`, "im Büro oder remote", "Bürotage", "Mobilarbeit", "Office-First-Kultur".

The work arrangement affects the hard filter: a `remote` job has its location judged as "remote within the EU", so a JD that clearly says remote but whose location is outside the range (Manila, Remote - India) is filtered out, while a remote job that says "Germany" passes.

## German level (`german_level_required`)

This is the local-language step of the German market: the rules come from the market pack (`config/packs/de/language.yaml`), and a market whose pack has no rules for its language skips the step (see [market-packs.md](market-packs.md)).

| Value | Meaning | Penalty |
|---|---|---|
| `B1`…`C2` | The JD requires this level ("fließend", "verhandlungssicher", "gute Deutschkenntnisse", "German C1") | Per `ai.yaml: scoring.language_penalty` |
| `preferred` | German is only a plus ("German is a plus", "Preferred: Fluent in German", under a "Preferred Qualifications" heading, "von Vorteil") | No penalty |
| `none` | The JD says German is not needed ("No German required") | No penalty |
| `unknown` | No level mentioned | No penalty |

- The plus words (`german_optional_patterns`) only count when within `german_optional_max_distance` characters of "German", not the whole clause: in a LinkedIn description without punctuation, one "clause" can be a whole paragraph.
- German after a "preferred" heading (`german_preferred_section_patterns`, for example Preferred Qualifications / Nice to have) is `preferred`, unless another heading is met (`german_required_section_patterns`) or the same sentence has "required / erforderlich" (`german_required_patterns`).
- For language lists such as "German, Spanish, French or Italian are a plus": when everything after the comma is a language name, the trailing plus word still counts for German (`german_list_languages`).
- "C1-Deutschkenntnisse sind von Vorteil, B2-Niveau ist ausreichend": after a plus word, a "level + ausreichend / genügt / sufficient / enough" in the same sentence (`german_sufficient_patterns`) says that level is the actual minimum, so it is read as that level (this example reads as B2, with a penalty).
- Phrases that are not about the language, such as "German citizen" and "German defence company", are erased first (`german_ignore_patterns`).
- Cross-check between the AI's `german_level_required` and the rule value: when they disagree, the one with a CEFR level explicitly written in the JD wins, counting only "requirements" (the C1 in "German C1 is a plus" is not explicit); when the rules read `preferred` / `none`, the rules win. For jobs already scored, the penalty is recomputed from the new rule value before each scoring (no AI call).

## Agency / recruiter (`is_agency`)

The company name is in `company.agency_names`, or matches `agency.company_name_patterns`, or the title / body matches `agency.text_patterns` ("on behalf of one of our customers", "exclusively retained", "I'm hiring … to join a … company", "Im Auftrag unseres Kunden", "recruitment agency", "Personalberatung"). Sentences where the employer says it does not want agencies ("we do not accept unsolicited CVs from recruitment agencies", `agency.exclude_context_patterns`) do not count. The flag only grows when merging, so a full `pnpm reprocess` first clears the work arrangement, German level and agency flags on the jobs and then rebuilds them from the original text.

## Contract type (`contract`)

The `contract` section: student / internship is judged only from the title and the contract hint; then temp agency work, freelance, fixed-term (`fixed_term`) and permanent (`permanent`). The order is: student > temp_agency > freelance > fixed_term > permanent, so "Vollzeit, befristet" is fixed-term. Temp agency work is recognised only by `Zeitarbeit` / `Arbeitnehmerüberlassung` themselves: "Personaldienstleister" only says the poster is an agency and no longer counts as temp agency work; when the body states that an agency is recruiting on behalf of a client and the hire is direct employment with the client (`contract.direct_hire`: "Vertragsart: Personalvermittlung", "Direktvermittlung", "im Rahmen der Personalvermittlung", "direkte Festanstellung bei unserem Kunden"), it does not count as temp agency work even if the agency's company profile mentions Zeitarbeit. Such jobs are kept, and are labelled "agency" through `agency` (`agency.text_patterns` includes `Personalvermittlung` and `Personaldienstleister`). German and English spellings were added: `unbefristet`, `Festanstellung`, `open-ended contract`, `Dauerstelle`, `Mutterschaftsvertretung`, and the labelled `Employment Type: Permanent` and `Art der Anstellung: Festanstellung`. Vollzeit / full-time describes working hours, not the contract term, so it does not count as permanent and the contract stays `unknown`. "full-time employees" and "equal employment opportunity" in benefits do not count. Most JDs do not state a contract type at all, so it remains `unknown`.

## Agency list and wording additions

`company.agency_names` was extended with Haystack, Rocken, Instaffo and Optimus Search; `agency.text_patterns` was extended with "hiring on behalf of …" and "Im Kundenauftrag".

## Cross-company name merging

When the same job has differently written company names in different sources ("SIV.AG" / "SIV.AG - Service für Informationsverarbeitung AG", "Allianz in Deutschland" / "Allianz Kunde und Markt GmbH"), duplicates used to be searched for only under the same company name, so merges were missed. Now two postings are merged only if the company names are related (one is a word-prefix of the other, or the first word is the same), the titles are identical, and the SimHash distance is ≤ `dedupe.cross_company_simhash_max_distance` (default 14, wider than the same-company `simhash_max_distance`, because the same JD has different boilerplate on StepStone and LinkedIn). Duplicates already in the database are not merged retroactively; this only applies to jobs that come in afterwards.

## Location on source rows

Each row of the source section on a job's detail page shows the location that source itself wrote (`job_sources.location_label`; `pnpm reprocess` fills in the location of existing sources). When a job is merged from several postings of the same company's ATS (for example the various Databricks offices), this is what tells the rows apart.

## Description cleanup (`description`)

- `trailing_ui_patterns`: removes UI text the collection left at the end ("Show more Show less").
- `restore`: a long description with no line breaks at all (Bright Data's `job_summary`) has its paragraphs and lists restored from known sub-headings, inline list markers and sentences, only adding line breaks and changing no text. The Bright Data LinkedIn dataset now also requests `job_description_formatted` (HTML) and prefers it when present, keeping paragraphs and lists as they are; older collected records lack this field and go through the cleanup above.

## Reprocessing jobs already in the database

```bash
pnpm reprocess            # all channels
pnpm reprocess --channel linkedin-brightdata
```

(Run in the project directory.) A full run first clears the work arrangement, German level and agency flags on the jobs (with `--channel` it does not clear, it only adds), then puts the already parsed original text back to pending, and runs in turn `pipeline`, salary (re-reads the original text of all jobs with the current parser and corrects the stored salary, see [signals.md](signals.md); with `--channel` it is also all jobs), the hard filter, rule signals, salary-signal sync, bonuses, and the German penalty for already scored jobs; it does not collect and does not call the AI. The exit code is 1 when some jobs were deferred or a rule scan failed, and 2 for an argument error. For jobs whose description changed: rule signals are re-scanned, and the AI signal review and the translation are redone as needed in later processing cycles (this uses AI quota).
