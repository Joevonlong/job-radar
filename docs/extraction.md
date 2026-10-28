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

## Company and title keys

Postings are matched to the same job (and to the same company) by keys: the company key is the company name in lower case
with accents and legal forms (GmbH, Inc. ...) removed, the title key the title in lower case without gender markers
("(m/w/d)") and punctuation; the exact match also compares the city. All three keep the letters and digits of every
script, so "Яндекс", "株式会社メルカリ" and "Ørsted A/S" each have a key of their own, "バックエンドエンジニア" and
"プロダクトデザイナー" at the same company are two jobs, and so are the same role in 東京 and in 大阪. Only the accents of Latin,
Greek and Cyrillic letters are folded ("é" = "e"); the marks that are part of a letter in other scripts stay (Devanagari
and Thai vowel signs, the Japanese voicing marks: ジム and シム are different words). ß reads as ss, so "Straße GmbH" and
"Strasse GmbH" are one company. A company name without any letter or digit keys as itself; a title without any is never
used to match two postings (only the same-source and SimHash checks can merge it).

Versions before this one kept only the letters a–z and digits: a name, title or city written in another script
(Cyrillic, Greek, Hebrew, Arabic, CJK ...) keyed as nothing, or as its Latin part only ("シニアAIエンジニア" as "ai"), and
letters such as Ø, Ł, Æ or ß in company names were dropped. **After upgrading**, the first cycle (or `pnpm reprocess`)
recomputes the stored keys once, before it files new postings:

- only keys the new rule changes are touched; German company names with ß are re-keyed once. A database whose names and
  titles are only in Latin script without such letters is not changed at all;
- two companies that now have the same key are folded into one: jobs, salary lookups, aliases, ATS board and watched /
  blacklisted marks are kept; cached salary lookups follow the new company and title keys;
- a watched or blacklisted company whose name mixes scripts ("Mercari, Inc. (株式会社メルカリ)") used to share its key with its
  Latin spelling ("Mercari Inc."); it gets a second row with the same marks for that spelling, so both stay marked.
  Clearing a stored watched or blacklisted mark on either row clears that mark on the reciprocal alias row too;
- if the keys cannot be recomputed (a database error), the cycle files no postings: they stay pending, the pipeline step
  is reported as failed and the next cycle tries again. `pnpm reprocess` stops with exit code 1 in that case.

Jobs that the old keys had already merged by mistake (two employers under one company, two roles under one title) stay
merged until you run this once:

```bash
pnpm reprocess --split-merged
```

It checks every job that has a posting whose company, title or city key changed and detaches only the postings the old keys
had matched to it and the new ones do not (postings merged as the same posting from another source, or by an almost
identical description, stay). Then it reprocesses as usual: each detached posting becomes a job of its own under its own
company (or joins the job it really belongs to). The job itself keeps its status, application, notes, favourite and
score. A job you acted on (application, favourite, filter or closure decision) never changes company: when its own postings
now name another company it is left as it is; both kinds are listed by id at the end of the run, worth a look. Nothing
to do when all your postings are in Latin script. When the old keys merged two cities written in another script (東京 and
大阪), the retained job's locations are rebuilt from its remaining postings in the same transaction as the split. Each
detached city's posting can then become its own job, including when the original job holds an application or favourite.
Every linked raw posting is read, including pending postings and earlier parse failures. If any retained posting cannot
be parsed now, the whole split for that job is skipped and its id is listed for manual review; all sources and locations
stay intact. Fix parsing for that source before retrying the split.

LinkedIn guest postings use the same numeric job id as the session and paid channels, so a title or location spelling
change between those channels does not create another job. Upgrading removes the guest `li-` prefix from stored ids;
raw payloads and source links are kept. If a partial upgrade already stored both spellings, both records remain readable
and match the same identity. Previously duplicated jobs are not automatically merged.

## Location on source rows

Each row of the source section on a job's detail page shows the location that source itself wrote (`job_sources.location_label`; `pnpm reprocess` fills in the location of existing sources). When a job is merged from several postings of the same company's ATS (for example the various Databricks offices), this is what tells the rows apart.

## Description cleanup (`description`)

- `trailing_ui_patterns`: removes UI text the collection left at the end ("Show more Show less").
- `restore`: a long description with no line breaks at all (Bright Data's `job_summary`) has its paragraphs and lists restored from known sub-headings, inline list markers and sentences, only adding line breaks and changing no text. The Bright Data LinkedIn dataset now also requests `job_description_formatted` (HTML) and prefers it when present, keeping paragraphs and lists as they are; older collected records lack this field and go through the cleanup above.

## Reprocessing jobs already in the database

```bash
pnpm reprocess            # all channels
pnpm reprocess --channel linkedin-brightdata
pnpm reprocess --split-merged   # once after upgrading, see "Company and title keys"
```

(Run in the project directory.) A full run first clears the work arrangement, German level and agency flags on the jobs (with `--channel` it does not clear, it only adds), then puts the already parsed original text back to pending, and runs in turn `pipeline`, salary (re-reads the original text of all jobs with the current parser and corrects the stored salary, see [signals.md](signals.md); with `--channel` it is also all jobs), the hard filter, rule signals, salary-signal sync, bonuses, and the German penalty for already scored jobs; it does not collect and does not call the AI. The exit code is 1 when some jobs were deferred or a rule scan failed, and 2 for an argument error. For jobs whose description changed: rule signals are re-scanned, and the AI signal review and the translation are redone as needed in later processing cycles (this uses AI quota).

Reprocessing holds the same exclusive database lock as a cycle. If that connection is lost, the filter and signal stages
stop at their next cancellation check, without starting another batch or job, and the command exits with code 1.
