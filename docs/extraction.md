# Job information extraction rules

The processing pipeline (the `pipeline` step) reads a few facts out of the JD text. The word lists and thresholds are all in `pipeline.yaml` (a shipped file: write the keys you change into `data/config/pipeline.yaml`, see [overlay](configuration.md#your-file-is-an-overlay)); after changing them, use `pnpm reprocess` to make jobs already in the database be re-read under the new rules (the collected original text is not touched). The principle stays the same: whatever the JD does not say is `unknown`; nothing is guessed.

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

## Merging duplicate jobs

A new posting joins an existing job when one of four checks finds one, in this order:

1. **Same source**: the same external id from the same channel family.
2. **Exact key**: same company, same normalized title, same city.
3. **Description**: same company and a SimHash of the description within a limit.
4. **Related company**: a company whose name is a variant of this one's, the same normalized title, and a SimHash within
   `dedupe.cross_company_simhash_max_distance`.

Companies often reuse one description for different levels and directions, so check 3 alone can merge different jobs. The
optional title check, `dedupe.title_guard` in `pipeline.yaml`, compares the titles first. It is off by default: a check of
real data still lost more true duplicates than this feature accepts, mostly titles reworded in ways no rule can read.

| Relation | Means | Limit |
| --- | --- | --- |
| `same` | the normalized titles are equal | `same_title_max_distance` |
| `compatible` | the titles differ only by a city, a country both postings are in, a work mode, a gender marker, spelling (`synonyms`) or word order | `simhash_max_distance` |
| `different` | anything else | `different_title_max_distance` (`null`: never on the description alone) |

With the check on, the nearest candidate within its limit wins, then the oldest. With it off, the first candidate within
`simhash_max_distance` wins, whatever its title. Levels, regions (`scope_words`) and translated titles count as different.
The other keys are the word lists the comparison uses: `city_connectors`, `work_mode_words`, `seniority_words` and
`ignore_patterns`. Cities come from the market's table and the postings' own locations.

The commented block in the shipped `pipeline.yaml` lists the defaults, and `pnpm config:check` holds it equal to the code.
To turn the check on, your `data/config/pipeline.yaml` needs `dedupe.title_guard.enabled: true`. That file replaces the
shipped one as a whole, so the other shipped defaults stop following product updates until you delete it.

The check applies to postings filed from then on. Merges already made stay, and `pnpm reprocess` does not match jobs again.
Turning it back off is equally safe: jobs kept apart stay apart, and new postings follow the old rule.

To see what a change would do before making it, replay a snapshot of your own database. Nothing is written to it, and the
snapshot holds full postings, so keep it outside any repository:

```bash
pnpm simhash:analyze --export <file> --compose-dir <installation directory>
pnpm simhash:analyze --guard --input <file> [--same-title-max N] [--seed N]
```

The report compares the old rule with the current config, sweeps `same_title_max_distance` from 3 to 8, and lists the merges
lost, the merges added and the postings moved to another job, plus a sample of stored merges whose titles differ.

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

## Merging duplicate companies

One company can end up as two rows in `companies`, usually through a source that gives a slug (`Alephalpha` next to `Aleph Alpha`). `/companies` then shows two rows and a watch or blacklist mark lands on only one of them. `pnpm companies:merge` lists likely duplicates and merges the pairs you confirm. It never merges anything on its own and is not part of a cycle.

```bash
pnpm companies:merge --suggest [--tier 1|2]        # list candidates, in the plan file's format
pnpm companies:merge --suggest --out plan.txt      # the same, written to a file
pnpm companies:merge --pair FROM:INTO              # dry run for one pair (repeatable)
pnpm companies:merge --plan plan.txt               # dry run for a plan file
pnpm companies:merge --plan plan.txt --apply       # merge
pnpm companies:merge --undo MERGE_ID [--apply]     # dry run, or undo one merge
pnpm companies:merge --list                        # the recorded merges
```

A plan file has one `FROM_ID INTO_ID` per line, and everything after `#` is a comment. `FROM` is the row that goes, `INTO` the row that stays. Exit code 0 means everything succeeded or there was nothing to do; 1 means a pair failed or was refused, a cycle or reprocess holds the lock, or a salary or company background request is running; 2 means bad arguments or a bad plan file.

**Candidates.** Tier 1: the two rows share a stored or resolved key, or have the same key once hyphens are removed. These have been spelling differences of one company. Tier 2: the keys match after removing a word from the end (`company.duplicate_tail_words` in `pipeline.yaml`), or the names match before a `(`, `|`, `–`, ` - ` or `,`. Tier 2 also finds parents and subsidiaries (Allianz / Allianz Services), so check each group yourself. A suggested direction keeps a row that is not written like a token, then a marked row, then in tier 1 the spelling with word breaks over its run-together form (`Aleph Alpha`, not `Alephalpha`), then the row with more jobs, then the older id; swap the two ids in the plan to keep the other one.

**Steps.**

1. `pnpm companies:merge --suggest --tier 1 --out plan.txt`, then read it and delete or change lines. Use `--out` and not `>`: a redirect also catches the lines pnpm prints, and `--plan` refuses such a file.
2. `pnpm companies:merge --plan plan.txt`, and read the dry run. It writes nothing, takes no lock and runs in a read-only transaction.
3. `scripts/ops/backup.sh --label pre-company-merge`, see [Backup and restore](backup-restore.md#2-manual-backup).
4. `pnpm companies:merge --plan plan.txt --apply`, and note the merge ids it prints. The filter results are recalculated by the next cycle; there is nothing to run by hand.

Each pair is its own transaction. A pair that fails leaves no trace and the others still run. Running the same plan again reports the finished pairs as already merged and exits 0.

**What a merge does.**

| Item | Result |
|---|---|
| Name and key | Those of `INTO`. Swap the direction to keep the other name |
| Jobs | All move to `INTO`, with their applications, favourites and scores. Jobs with the same title stay separate; the dry run counts them |
| Aliases | The name and aliases of `FROM` join those of `INTO` |
| ATS | `INTO` keeps its own; it takes the one of `FROM` only when it has none |
| Watch and blacklist | Combined. A pair with one row watched and the other blacklisted is refused: clear one on `/companies` first |
| Website domain | A domain you confirmed wins; of two confirmed, the later one. The dry run warns about the other |
| Company backgrounds and salary lookups | Move to `INTO`, and the salary cache keys follow. Both sides' results are kept and the newest is read |
| `watched_companies` in `interests.yaml` | Not edited. An entry that matched only `FROM` stops matching, so `INTO` gets the stored watched mark and the output asks you to edit the file |
| `trusted_companies` in `ui.yaml` | Not edited. The output says when an entry stops matching |
| `exclude_companies` in the preferences | Not edited. It compares aliases too, so **an entry for `FROM` excludes all of `INTO` after the merge**. The dry run warns about it |
| `visa.exclude_companies` in a market pack | Compares the key only, and is recalculated with the key of `INTO` in the next cycle |

**New postings.** A posting whose key has no company row of its own, but equals the key of an alias stored on a company, goes to that company, so a merged spelling does not grow its row back. A key with a row of its own stays on that row. A key that the aliases of two companies give is not redirected, and the pipeline logs a warning. Stored aliases are what count here: removing an alias from `pipeline.yaml` does not separate companies again.

**Undo.** `--undo MERGE_ID --apply` restores the `FROM` row with its original id, moves the recorded jobs, salary lookups (with their original keys) and backgrounds back, and removes the aliases this merge added. The marks, ATS and website domain of `INTO` return only if they still have the values the merge left; otherwise they stay, and the output names them. Undo is refused when the merge was already undone, another row now has the key of `FROM`, `INTO` is gone, or a later merge that is still in force involves these rows (undo that one first).

Undo cannot put back everything that arrived after the merge, so its dry run and its run both print the count of new jobs on `INTO` and of new postings on the jobs concerned. These counts go by when a job or posting was first seen, so they are a guide and not an exact list of what the merge caused: they include what the kept company's own spelling brought, so a number above zero is normal, and they miss a posting fetched before the merge and processed after it.

- A new job on `INTO` from a posting spelled like `FROM` stays there. After the undo, run `pnpm reprocess --channel <channel>`: a job whose only source spells `FROM` moves back to `FROM`.
- A posting that was merged into an existing job (same title and city, or a near-identical description) is not separated again. If it won, it may also have rewritten that job's title and description. Only restoring a backup reverses that.

While the two rows are merged they also share salary cache keys. A salary lookup or company background made in that time for a moved job stays on `INTO` after the undo, and the job on `FROM` does not see it; both outputs print how many there are. So check a tier 2 merge soon after it runs, and undo it the same day if it is wrong.

**Limits.**

- Undoing a merge of a slug-spelled row that also has a board in `ats_boards` (`sources.yaml`) does not last: the next cycle's display-name sync folds the row again without a merge record.
- Folds made by the display-name sync or by a key refresh write no merge record, so `--undo` cannot reverse them.

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
