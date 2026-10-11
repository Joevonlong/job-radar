# StepStone fixtures

Synthetic pages that keep the structure of StepStone's public pages (plain HTTP, no login) and nothing else: the embedded data
(`window.__PRELOADED_STATE__["app-unifiedResultlist"]`, the JSON-LD `JobPosting`, `JobAdContent`) inside a minimal page, with the same
fields, nesting and edge cases the channel reads. Employers, ids, links, recruiter contacts and ad texts are invented
(fictional employers, ids in the 9000xxxx range, `example.test` contact addresses, short made-up job ads); no recorded
page, company name or ad text is kept. A decoy script mentions `captcha` because the real pages do (a healthy page must not look blocked).

| file | shape |
|---|---|
| `search-berlin.html` | a search result list, 8 results (main + semantic sections, one old, one off-topic title) |
| `search-remote.html` | a home-office search, 4 results: one `main`, three `recommended` filler |
| `search-empty.html` | the same page with no results |
| `detail-berlin.html`, `detail-multicity.html` | posting pages with JSON-LD (German and English text; one with several cities) |
| `detail-no-jsonld.html` | a posting page with the JSON-LD block removed, to exercise the section fallback |
| `blocked-403.html` | the 403 "Access denied" page, reduced to its title and message |

The recruiter contact blocks use synthetic values (`Max Mustermann`, `*@example.test`).
