# Berlin Design Network fixtures

Made up. Companies, links and contact details are invented (`*.example` domains; the ATS links use the real host shapes with
invented tokens). `jobs.html` only follows the structure of the real page as observed on 2026-10-24: a Next.js page whose
`__NEXT_DATA__` holds `props.pageProps.page.pageData.jobs[].attributes` with `link` and `at_company_text`, and for some entries a
nested `at_company` object with contact details (here invented: `hiring@fiction.example`, `+49 30 0000000`).

- `jobs.html`: Personio (two postings of one board), Ashby, Greenhouse, Lever (and the EU host), a board listed in `ats_boards`,
  links to LinkedIn, StepStone, Baito, a company site and `personio.com`, entries without a company name, a padded name, and three
  entries of a wrong shape (a `link` that is a number, no `attributes`, not an object).
- `no-data.html`, `broken-json.html`, `jobs-not-array.html`, `other-shape.html`: pages that cannot be read as the job list.
