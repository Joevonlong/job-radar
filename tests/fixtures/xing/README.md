# XING fixtures

Synthetic pages that keep the structure of XING's public job pages (plain HTTP, no login): the `window.crate.serverData.APOLLO_STATE`
(reduced to the search result and the job entities) and the JSON-LD `JobPosting`, inside a minimal page. Bare `undefined` values and a
decoy `captcha` string are kept because the real pages have them. Employers, ids, links and ad texts are invented (fictional employers,
ids in the 9010xxxx range, `example.test` apply links, short made-up ads); no recorded page, company name or ad text is kept.

| file | shape |
|---|---|
| `search-berlin.html` | a search result list, 6 results (two refreshed recently, one old; salary estimate / range / none; third-party apply) |
| `search-empty.html` | the same page shape with no results |
| `detail-third-party.html` | apply on the employer's site (`UrlApplication`), salary estimate, partly remote |
| `detail-remote-nosalary.html` | fully remote, English, no salary |
| `detail-salary-range.html` | employer-stated `SalaryRange` (also in the JSON-LD `baseSalary`), on-site |
| `detail-estimate-remote.html` | salary estimate, fully remote, description with a contact block |
| `blocked-challenge.html` | a verification page (XING was never observed blocking) |

Contact names, phone numbers and e-mail addresses are synthetic (`Max Mustermann`, `Erika Musterfrau`, `+49 30 1234567-89`, `*@example.test`).
