# Handpicked fixtures

Made up. Companies, postings and links are invented (`*.example` domains; the ATS links use the real host shapes with invented
tokens). They only follow the structure of the real job index as observed in 2026-10: the root of `search-index.json` is an array,
`postedAt` is a date without time, `cities` holds lower-case place slugs, and a posting detail is
`{ id, descriptionHTML, url, company }`.

- `search-index.json`: entries for place selection, age, title prefilter, known boards, board shapes without an adapter (join.com,
  Workday, myjobboard.de), a sponsored entry, and two broken entries (a date that is not a date, a missing `url`).
- `details/<id>.json`: details of the postings the tests pick. `b000000004` holds a contact e-mail and phone number,
  `b000000005` a hidden instruction, `b000000003` a `url` that differs from the index.
- `index-object.json`: the wrong root (an object). `index-empty.json`: an empty array.
