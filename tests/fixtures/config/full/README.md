# full

Full copies of user config directories, the inputs of the golden effective-config tests (`tests/config/golden.test.ts`)
and of the overlay conversion invariant. Each directory is a user config directory over `../defaults`; a `profile/`
subdirectory, when present, is its profile directory.

- `edited`: the `user` files of `../defaults` plus copies of `pipeline.yaml` and `job-archive.yaml`, with a few values changed, an entry added
  to a record, a keyword group added and comments added.
- `missing-keys`: the `user` files with keys removed: one whose schema default differs from the shipped value
  (`language.yaml` `ai.summary_also`), one whose default equals it (`schedule.yaml` `backup.max_age_hours`), record
  entries (a glossary term, a language penalty) and a key without a default (`sources.yaml` `jobspy.country_indeed`).
- `old-versions`: files that the loader migrates in memory: `interests.yaml` and `notify.yaml` at config_version 1
  (`../interests.v1.yaml`, `../notify.v1.yaml`) and the files of `../legacy-de` (including `profile/preferences.yaml`).

Do not edit them without regenerating the golden files (`scripts/dev/gen-config-golden.ts`): the golden hashes were
taken with an older loader, and an edit here would make them disagree for no reason in the code.
