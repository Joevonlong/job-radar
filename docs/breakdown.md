# Job breakdown

Breaks a JD into a structured "what this job needs": responsibilities, tech stack (by category), experience requirements, projects / outcomes, soft skills, languages, and other. Each item is marked "required" or "nice to have" and carries a quote from the JD; click "Source" to jump to the JD and check it. When your profile has skills, it also gives an "you have / to strengthen" comparison, to help you look at the match and plan how to close gaps.

## Off by default, analysed on demand

Each breakdown costs one AI call (subscription quota and 1–3 minutes), so:

- `data/config/breakdown.yaml` has `enabled: false` and `mode: manual`.
- Once enabled, it analyses **only when you click the button** (manual) by default. Auto mode is for you to switch on yourself, and it only handles high-scoring jobs, with a per-cycle limit.
- For cost, look at the "Breakdown" row of the "AI usage" card on `/sources`: each breakdown = 1 call.

## How to enable

Settings page → "Breakdown" tab:

| Item | Key | Notes |
|---|---|---|
| Enable job breakdown | `enabled` | When off, the detail page has no breakdown button and nothing is broken down automatically; existing results are still shown (read-only) |
| Mode | `mode` | `manual`: only when you click the button on the detail page; `auto`: at the end of each cycle, high-scoring jobs are broken down automatically |
| Minimum rank value / maximum per cycle | `auto.min_rank` / `auto.per_cycle_limit` | Only effective in `auto`; from the highest rank value down, whatever is not finished continues next cycle |
| Maximum JD characters sent to the AI | `jd_max_chars` | Longer ones keep only the beginning and the end |
| How long one breakdown may take | `timeout_seconds` | On timeout, move to the next provider |

`jd_head_share` (the share the beginning takes when truncating) is not in the form; edit the YAML directly. After saving, the runner / ai-worker hot-reload in about 5 seconds; the web app re-reads this file each time a detail page is opened.

## Which AI is used

It follows the task overrides of `ai.yaml`, with the task name `breakdown`. If not set, the global order applies (codex-cli first by default). The "Task overrides" on the "AI" tab of the settings page gets an extra "Breakdown" row, and codex's "Reasoning effort: breakdown" is there too. Breakdown output is fairly long (about 2–4k tokens), and the API providers' `max_output_tokens: 4096` may not be enough for a very long JD (if the output is truncated, it moves to the next provider), so we recommend putting the subscription CLIs first; add `tasks.breakdown: {order: [codex-cli, claude-cli, api]}` if needed.

> Upgrade order: `tasks.breakdown` and `reasoning_effort_by_task.breakdown` in `ai.yaml` may only be written **after the code that supports job breakdown is deployed** (older versions have a strict schema). `breakdown.yaml` is a new file that older versions do not read, so adding it early is safe.

## The card on the detail page

Location: the main column of the detail page, between "Match reasons / gaps" and "JD". States:

| State | When | What to do |
|---|---|---|
| Not enabled | `enabled: false` and this job has no result | Click "Go to settings to enable" |
| Config unreadable | `breakdown.yaml` is invalid | Run `pnpm config:check` |
| No JD text | The source gave no description | Cannot be broken down |
| Ready to break down | Enabled, has a JD, no result yet | Click "Break down this job" |
| Queued / Breaking down | The request is in the queue / the ai-worker is processing it | Wait; the card shows how many requests are ahead and what the ai-worker is doing, or since when it runs. If the ai-worker has no fresh heartbeat, the card says it is offline (with a link to the Sources page) and keeps waiting |
| Failed | See the table below | Look at the reason, click "Retry" |
| Broken down | There is a result for the current version | Click a tag / "Source" to jump to the JD text |
| Stale | The JD changed after the breakdown, or it was broken down with an old prompt version | The result is shown as usual with a badge at the top; click "Break down again" |
| Old version | The stored format is not recognised | Click "Break down again" |
| AI found nothing | The breakdown succeeded but every category is empty | You can break down again |

After the switch is turned off, jobs that already have a result still show it, just without the "Break down again" button.

Failure reasons: `no_verified_quotes` (none of the quotes the AI gave match the JD text; nothing was saved, just retry); `aborted` (the ai-worker restarted); `auth` / `timeout` / `rate_limited` / `invalid_output` / `provider_error` / `network` / `budget` / `unavailable` / `failed` (reasons for an AI failure, same as translation); `disabled` (turned off after being queued).

Being "Queued" forever is almost always because the ai-worker is not running: look at the ai-worker card on `/sources`; once it starts, the request is claimed.

## Quote verification: drop what does not match

The prompt requires every item to be copied verbatim from the JD as one sentence (`quote`). The code searches for each quote in the full JD (tolerating line breaks as spaces): if found, the JD's own text and position are saved; if not found, the item is dropped and counted (the meta line shows "N dropped"). When an experience-years quote does not match, the years are cleared as well. The tech stack is de-duplicated by canonical name ("LLMs" and "LLM" count as the same), required items first. Anything the JD does not say is not guessed, and empty categories are not shown.

Quotes are marked in the JD text with a **dotted underline**; when the same text is also a signal quote, it is shown in the signal's colour, and the breakdown item jumps to that signal marker.

## How "you have / to strengthen" is calculated

Computed only locally; the profile is not sent to the AI. It uses `skills` from `data/profile/me.yaml`, compares after normalising skill names, and also recognises the aliases in `pipeline.yaml: skills[].aliases` (the profile says `k8s`, the JD says Kubernetes: counts as a match). Shown: each tech tag as "have / missing"; the number of hits among required and among nice-to-have items; the "to strengthen" list (required first); and, when the JD states a minimum number of years, a comparison with `years_experience` in `me.yaml`. When the profile has no skills, this block prompts you to fill them in on "My profile".

## Versions

Every row carries a `prompt_version` (currently `breakdown-v1`). When the prompt or the output structure changes later, the version is bumped: old results can still be shown (the old version keeps its own schema) and are marked "broken down with an old prompt version", and you can also break down again manually; a format that is not recognised is shown as "Old version". Auto mode only fills in jobs with "no result / JD changed" and does **not** re-run everything because of a version bump (to save tokens).

## Data and boundaries

- Results are stored only in `job_breakdowns` (one row per job; breaking down again overwrites it). Nothing is written back to any field of `jobs`, and breakdowns take no part in scoring, ranking, push or filtering.
- The `breakdown_job` request is claimed only by the host ai-worker; the web app only writes the request and polls for the result.
- When you refresh the page, reopen it, or open the same job in a second tab, the card restores its state from the job's latest `breakdown_job` request on the server: queued / breaking down keeps polling; the most recent failure (if later than the stored result) shows the reason and a retry. The translation tab treats unfinished `translate_job` requests the same way.
- The model name in a result is the real model name: when codex had no model specified, it writes the `cli_default` model from the model catalog (`models.yaml`), and the card marks it "CLI default"; `codex-default` in old records is resolved the same way when displayed.
- Failure details contain only the provider name and the error type, not JD text or secrets.
