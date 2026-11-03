# Berlin Startup Jobs fixtures

Made up. Companies, people, e-mail addresses and links are invented (`*.example`). They only follow the structure of the real
WordPress REST API as observed on 2026-10-24: posts carry the 16 whitelisted fields, `title.rendered` has HTML entities,
`date_gmt` is a date without a zone, `job_company` holds exactly one term id and `job_location` the ids of Berlin / Remote /
Remote Possible. The scan tests set `per_page: 4` so that three pages cover paging.

- `posts-page-1.json`: four posts. `1001` also carries `_invoice_url` and `yoast_head` (the keys a server that ignores `_fields`
  would send), `1002` is a student job in German, `1003` has two separators in its title and two places, `1004` has an e-mail
  address, a phone number and hidden text in its description.
- `posts-page-2.json`: a repeat of `1001`, a remote-only job, one whose end date has passed, one listed in June with no end date.
- `posts-page-3.json`: a title without a separator whose company term does not exist, and a job with a `mailto:` link.
- `job_company.json`, `job_location.json`: the terms (`id,name,slug,link`) the posts point to.
- `posts-malformed.json`: an object instead of an array. `posts-bad-item.json`: an array with two bad entries and one good one.
