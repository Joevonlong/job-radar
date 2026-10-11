# Arbeitnow fixtures

Synthetic pages that keep the structure of the free Arbeitnow Job Board API (`GET /api/job-board-api?page=N`) as observed on
2026-10-09: `data` (job objects with exactly the ten fields `slug`, `company_name`, `title`, `description` (HTML with inline
styles and the "Find more … on Arbeitnow" footer), `remote`, `url`, `tags`, `job_types`, `location`, `created_at` (Unix
seconds)), `links` (`next` is null on the last page) and `meta`. Employers, slugs, titles and texts are invented; no recorded
posting is kept.

The timestamps are relative to `2026-10-09T12:00:00Z` (the tests' "now"); ages below are in hours before it.

| file | shape |
|---|---|
| `page-1.json` | 6 jobs, not ordered by age (5, 1, 3, 10, 8, 30 h): a German HTML description, a remote job, `Hamburg or Berlin`, a hidden `display:none` span, a contact block (name, e-mail, phone), an empty `location` and an `Internship` job type |
| `page-2.json` | 4 jobs: one repeats a slug of page 1, one (40 h) is outside a 24 h window, the others inside |
| `page-3.json` | 3 jobs, all 25–28 h old (outside a 24 h window) |
| `page-empty.json` | no jobs, `links.next` null |
| `page-malformed.json` | no `data` array |
| `page-bad-items.json` | a job with a string `created_at`, a valid job and an object missing most fields; `links.next` null |

Contact data is synthetic (`Erika Musterfrau`, `kontakt@example.com`, `+49 30 1234567`).
