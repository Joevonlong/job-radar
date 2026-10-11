# LinkedIn session fixtures

Hand-written pages that follow the structure of LinkedIn's logged-in job pages (list cards `li[data-occludable-job-id]`, the unified top card,
the JSON-LD `JobPosting`) plus the pages that mean "stop": the sign-in page, an auth wall and a verification (checkpoint) page.
Companies, jobs and numbers are invented; there is no account name, contact person, profile link or tracking id in them.

They were NOT recorded from a live session (nobody has logged in yet; the live smoke is pending, see docs/linkedin-session.md).
When a real session is available, record the pages (page.content()), strip personal data, and compare with these.

| file | page |
| --- | --- |
| search-results.html | `/jobs/search/` logged in: 6 cards (one promoted, one Easy Apply, one "(Remote)", one listed twice) |
| search-results-empty.html | `/jobs/search/` with no match |
| recommended.html | `/jobs/collections/recommended/` |
| job-detail.html | `/jobs/view/<id>/`: JSON-LD + top card + pills + description |
| job-detail-de.html | the same job in the German UI |
| job-detail-jsonld-only.html | a page with only the JSON-LD and a bare heading |
| job-detail-closed.html | a job that no longer accepts applications |
| job-unavailable.html | "this job is no longer available" |
| login-wall.html | the sign-in page (session not accepted) |
| authwall.html | the auth wall shown to a logged-out visitor |
| checkpoint.html | "quick security check" with a CAPTCHA frame |
| layout-unknown.html | a page without job cards or any known marker |
