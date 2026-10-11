# Weekly suggestions from your interest list

> **What is sent:** to make the suggestions, the jobs you marked (title, company, JD text and your status for each) and your preferences are sent to the AI provider(s) you have switched on. Switch the weekly run off with `suggest.enabled: false` in `schedule.yaml`. See [privacy.md](privacy.md).

Once a week, the AI looks at the jobs you marked **Interested / Preparing / Applied / Interviewing / Offer** (and the ones you **Ignored**, for contrast) and makes three kinds of suggestion: new **signal words** (T2 / T3 / T4 / benefit tags), **companies to watch**, and **filters** (exclude keywords, add cities, exclude companies). Suggestions are only proposals, shown in the "Learned suggestions" block of `/interests`; **only when you click approve are they written** to `data/config/interests.yaml` or `data/profile/preferences.yaml`, and if you do not approve nothing changes.

## How it runs
- The runner, per `suggest.cron` in `data/config/schedule.yaml` (default Monday 08:00, in `timezone`), leaves a `run_suggest` request (control request), which is executed by the process that runs AI (the runner, or the ai-worker on the host). If at runner start the most recent one was missed and `catch_up` is on, it adds a request to catch up.
- The "Find suggestions now" button on `/interests` can trigger it manually at any time; the result can be seen in the recent requests list of `/settings`.
- Command-line check: run `pnpm suggest:smoke --confirm-write <db name>` against a **copy of the database** (it writes `interest_suggestions`, changes no config file, and sends no Telegram message).
- With fewer than `min_positive_jobs` (default 3) liked jobs the AI is not called, and `/interests` shows "Too few interesting jobs".

## Every suggestion comes with evidence
- Signal words: must appear in at least `min_evidence.signal_word` jobs **you liked**, each with a **verbatim JD quotation**; the quotation must be a fragment that literally exists in that job's JD (whitespace ignored), and the word itself must be in the quotation; a suggestion whose quotation cannot be found is dropped entirely. Words already on the list (or already covered by some pattern) are not suggested again; words that are as common in ignored jobs as in liked jobs are not suggested either.
- Watched companies: attached are the jobs of that company that you liked (company names are matched after removing GmbH and applying aliases), and what is stored is the company name in the database.
- Filters: an exclude keyword must appear in jobs you ignored and **no liked job** may contain the word (a hard filter would filter those out too); an added city must be the city of a liked job; an excluded company must not be a company you have liked.
- Suggestions where the AI's confidence is below `min_confidence` are dropped; at most `max_suggestions` are stored each time (high confidence first).

## No repeats
Every suggestion has a dedup key (words are folded by case and whitespace, regardless of tier; companies by normalised name). A suggestion that is pending, approved or rejected is never proposed again. **Rejected = never shown again.**

## After approval
- It is written back with `writeConfig` (YAML comments preserved, atomic replace, zod validation). Words go into the `keywords` of the matching tier (benefit tags into `benefit_tags`), companies into `watched_companies`, filters into preferences.yaml (a snapshot of the profile is saved, and the related scores are marked stale and re-scored).
- Ranking values are recomputed immediately (`reconcileBonuses`, no AI call); new words only start to score once the next cycle's `signals` step rescans the JDs with the new word list (the page says so).
- When the config file cannot be read or written, the suggestion goes back to pending and nothing is lost.
- If the value is already on the list (you added it manually): it is marked approved and the file is not changed.

## Telegram
One message per week when there are new suggestions (both `suggest.notify` and `telegram.enabled` in `notify.yaml` are on; during quiet hours it is not sent, and the suggestions are still on the page). The message lists the first few, with a link to `/interests` (needs `public_base_url` in `notify.yaml`).

## Settings (`suggest` in schedule.yaml)
`enabled`, `cron`, `lookback_weeks`, `positive_statuses`, `ignored_statuses`, `min_positive_jobs`, `max_positive_jobs`, `max_ignored_jobs`, `jd_max_chars`, `max_suggestions`, `min_confidence`, `min_evidence`, `max_term_chars`, `notify`. These have no settings-page form; edit the YAML directly (the runner hot-reloads).
