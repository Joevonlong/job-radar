# Job-alert email fixtures

Synthetic HTML bodies of job-alert emails, two per platform (LinkedIn, StepStone, Indeed, XING). They are
built by hand to follow the publicly visible structure of each platform's alert email: table-based layout,
hidden preheader text, a logo link and a title link per card, company / location / badge lines, tracking
parameters on every link, redirect-wrapped links in some variants, footer with unsubscribe and settings
links. Companies, ids and people are made up; no real email or personal data was used or requested.

| File | Covers |
|---|---|
| `linkedin-digest-en.html` | 3 cards: `Company` + `Location (Hybrid/Remote)` lines, `Company · Location` in one line, salary line, status badges |
| `linkedin-digest-de.html` | German locale, redirect-wrapped links, slug-form link, card without location, logo-only block without a title |
| `stepstone-alert-table.html` | table cards, `-inline.html` ids, salary, badges, teaser, a salary *estimate* that must be ignored |
| `stepstone-alert-div.html` | div-based layout, click-tracking wrapper links |
| `indeed-alert-en.html` | `jk` links, rating, salary, badges, `viewjob` link |
| `indeed-alert-de.html` | `Company - Location` in one line, sponsored link without `jk` |
| `xing-alert-1.html` | `/jobs/<slug>-<id>` links, salary, salary prediction to ignore, teaser |
| `xing-alert-2.html` | card with missing company and location, a search link that is not a job |

Real emails may differ. When a real alert no parser reads shows up (`parse_failed` in `raw_postings`), strip
personal data from its HTML and add it here with a test.
