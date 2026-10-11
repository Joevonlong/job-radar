# JSearch fixtures

No live key was available while the channel was built, so the fixtures follow the vendor's published shapes.

| File | Where the shape comes from |
|---|---|
| `search-v2-sample.json` | The job record is the sample on the product page https://www.openwebninja.com/api/jsearch (shape of the vendor sample; all values invented); the envelope (`status`, `request_id`, `parameters`, `data.jobs`) follows the OpenAPI file https://openwebninja.s3.us-east-1.amazonaws.com/portal/openapi/jsearch.yaml (`/search-v2`). |
| `search-page.json`, `search-empty.json`, `job-details.json` | The older RapidAPI `GET /search` / `GET /job-details` envelope (`data` is an array), with records written by hand in the documented field set (OpenAPI file, `/job-details` and `/search-v2` records). Companies, links and ids are invented (`.example` hosts). One record has no title and one no `job_id`, to cover malformed records. `job_salary_currency` is not in the current OpenAPI file; the fixtures leave it out, so the currency comes from the salary text. |
| `error-invalid-key-401.json` | Answer of `https://jsearch.p.rapidapi.com/search` to a request with an invalid key, observed live on 2026-10-07. |
| `error-quota-429.json`, `error-rate-429.json`, `error-not-subscribed-403.json` | RapidAPI's platform error format (`{"message": "..."}`); the wording of these three is reconstructed, not captured, because no subscription was available. The channel classifies a 429 by the words quota / monthly, hour / day, and the `x-ratelimit-requests-remaining` header. |

Replace the reconstructed files with real captures when a key exists (the live smoke test is pending, see `docs/jsearch.md`).
