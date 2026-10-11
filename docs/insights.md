# Insights page: /insights

One page for "the market and my progress". The top right switches between 7 / 30 / 90 days (`?range=` in the URL, so refreshes and shared links keep it). "Today" and each day boundary follow `timezone` in `schedule.yaml`, and the range includes today.

## Configuration: `insights.yaml`

Defaults live in `data/config/insights.yaml`; your own copy lives in `data/config/insights.yaml` (see [`configuration.md`](configuration.md)).

| Key | Meaning |
|---|---|
| `ranges_days` / `default_range_days` | Which time ranges are offered (short to long) and the default |
| `cities` | Cities listed separately in the city card, written like the /jobs city filter (München, not Munich); empty (the default) = the `locations` of your preferences |
| `top_filter_reasons` | How many rows the "Filter reasons" card lists |
| `score_bucket_width` / `score_bucket_cap` | Bar width of the rank-value histogram, and the value from which everything goes into the last bar |
| `salary_bucket` / `salary_bucket_cap` | Bar width of the annual-salary histogram (in the market's base currency), and where the last bar starts |

The web app re-reads this file each time the page opens, so no restart is needed.

## How each card is computed

Every number is a SQL aggregate over the database, counted by "jobs first seen within the range" (`first_seen_at`, the same reading as the "first seen" date filter on /jobs). "Passed filter" = the job's latest score record is not `filtered_out` (jobs with no score record yet are also shown by default on /jobs, so they count as passed here too).

| Card | Definition | Click goes to |
|---|---|---|
| Key numbers | New (all), passed filter, share with salary disclosed, average rank value, applied | New -> /jobs (including filtered); passed filter -> /jobs; salary disclosed -> `salary=true`; applied -> /pipeline |
| Trend lines of the key numbers | Days that have data (days with new > 0, the pass rate of days that have jobs, the rank value of days that have scored jobs) are joined into one continuous step line; days without data are skipped instead of drawn as scattered points. With fewer than 2 days of data no line is drawn and "Not enough data (< 2 days)" is shown; the line width shrinks with the card and never draws into a neighbouring card (`lib/insights/trend.ts`) | n/a |
| New per day | Jobs per day that passed / were filtered out; days without jobs still get an empty bar | Passed bar -> /jobs for that day; filtered bar -> /jobs for that day, filtered-out jobs only (`filteredOnly=true`) |
| Source breakdown | By source family (`channels.family`); a job that appears in several sources is counted once per source; shows the share that passed the filter | Total -> `source=` + include filtered; pass share -> `source=` |
| City breakdown | Passed jobs only. A job counts if any of its locations matches a configured city (one job can be in several cities); remote is by workplace; other = neither remote nor in a listed city | City -> `city=`; remote -> `workplace=remote`; other has no matching filter and is not clickable |
| Salary disclosure | Passed jobs only: the share that states a salary. The annual-salary histogram only uses "comparable EUR annual salaries" (the same definition as the detail page and /me: `qualityStatus` is not review and not a salary from another region; ranges use the midpoint, one-sided figures use that end), bucketed with a median (the label states the range and count, e.g. "median · last 30 days · 8"; hidden when there are fewer than `ui.yaml: salary_stats.min_sample`) | Share -> `salary=true`; histogram bars are not clickable |
| Signals | Passed jobs only: for each signal category (except tag categories, in the order of `/interests`), the number of jobs with at least one signal of that category and their average rank value; and the number of jobs with none of them | The "high-value signals" count (it names the high-value categories) -> `high=true` (same definition as the quick filter on /jobs, including the salary floor rule of the amount category); hidden when no category is high value |
| Rank-value distribution | Passed and scored jobs only, bucketed by rank value; jobs still waiting for AI get their own count | Not clickable |
| Application funnel | New jobs = jobs that appeared in the range and passed the filter; each later stage = applications that entered that stage (or a later one) through a status change within the range; rejected / withdrawn / ignored are listed separately. Note that "interested" may be a job that appeared earlier, so new -> interested is not a conversion rate; the share relative to the previous stage is only given from "interested" onward | New -> /jobs; the rest -> /pipeline |
| Filter reasons | Jobs hard-filtered out within the range, counted by reason code (without the detail after the colon); a job can have several reasons | "Open filtered jobs" -> /jobs, filtered-out jobs only (`filteredOnly=true`) |

When there are no jobs and no application actions at all in a range, only an empty state is shown; when only a single card has no data, that card shows its own empty state.
