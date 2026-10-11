# Contributing

Thanks for your interest in Job Radar. It is a self-hosted, single-user tool, and contributions that keep it small,
configurable and safe with personal data are the most welcome: bug fixes, new channels, market packs for other
countries, translations, documentation.

## Before you start

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Read [docs/development.md](docs/development.md) for the code layout and the rules that shape the code.
- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go to [SECURITY.md](SECURITY.md),
  not to a public issue.

## Setup

```bash
pnpm install
docker compose up -d db
scripts/validate.sh
```

## Pull requests

- Branch from `main`; keep a PR to one change.
- Run `scripts/validate.sh`, `pnpm test:integration` and, for UI changes, `pnpm test:e2e` before you push. CI runs the
  same checks.
- Changing the CI (`.github/workflows/`, `.github/dependabot.yml`)? Update [docs/ci.md](docs/ci.md) and `docs/ci.zh.md` in the same pull
  request: `pnpm ci:docs-check` (part of `scripts/validate.sh`) fails when a job or step is missing from the docs or documented
  but gone. Every workflow step needs a `name:`. How the pipeline works and how to run it locally: [docs/ci.md](docs/ci.md).
- Add or update tests with the change. Tests build the configuration they need and never assert values of the shipped
  `config/*.yaml`.
- User-visible text goes into `messages/en.json` and `messages/zh.json`, never inline in components or scripts.
- Anything specific to one person, place or market (cities, keywords, companies, currencies, paths) is configuration,
  not code. A new country is a market pack of defaults, not a branch in the code.
- Never commit secrets, personal data, real job postings of private companies' internal systems, or your own
  `data/` directory. `scripts/release-check.sh` shows what the maintainers check before a release.
- User-visible change? Add one line under `## [Unreleased]` in `CHANGELOG.md` (see [RELEASING.md](RELEASING.md)).
- Commit messages: English, Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`).
- Documentation is English first; a Chinese counterpart (`*.zh.md`) is welcome but not required for a PR.

## Scraping channels

A new channel must respect the site's terms and robots rules as far as they apply, throttle itself, fail in isolation
(never stop a cycle), store the raw payload first, and never try to bypass a login wall or CAPTCHA.

## Licence and sign-off (DCO)

The project is licensed under the [AGPL-3.0](LICENSE). Contributions are accepted under the same licence
(inbound = outbound), and there is no contributor licence agreement (CLA). Instead every commit carries a
**Developer Certificate of Origin** sign-off, which says you wrote the change or have the right to submit it under this licence:

```
Signed-off-by: Your Name <you@example.com>
```

Add it with `git commit -s` (use your real name and an address you control; a GitHub noreply address is fine). The full text of
the certificate is at <https://developercertificate.org/>:

> By making a contribution to this project, I certify that (a) the contribution was created in whole or in part by me and I
> have the right to submit it under the open source licence indicated in the file; or (b) the contribution is based upon
> previous work that, to the best of my knowledge, is covered under an appropriate open source licence and I have the right
> under that licence to submit that work with modifications, whether created in whole or in part by me, under the same
> open source licence (unless I am permitted to submit under a different licence), as indicated in the file; or (c) the
> contribution was provided directly to me by some other person who certified (a), (b) or (c) and I have not modified it;
> and (d) I understand and agree that this project and the contribution are public and that a record of the contribution
> (including all personal information I submit with it, including my sign-off) is maintained indefinitely and may be
> redistributed consistent with this project or the open source licence(s) involved.

A pull request with unsigned commits will be asked to add the sign-off (`git rebase --signoff main`, then force-push).
