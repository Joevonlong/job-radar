## Summary

<!-- What changes and why. Link the issue if there is one ("Closes #123"). -->

## How to try it

<!-- Commands, pages or settings a reviewer can use to see the change. For UI changes, add screenshots
     (light and dark theme; phone width if the layout changes). Use demo data only, nothing personal. -->

## Checklist

- [ ] `scripts/validate.sh` passes (lint, typecheck, unit tests, config check, docs link check)
- [ ] Tests added or updated
- [ ] CI changed (workflows, Dependabot)? `docs/ci.md` and `docs/ci.zh.md` updated; `pnpm ci:docs-check` passes
- [ ] User-visible text is in `messages/{en,zh}.json`; docs updated (English, plus `.zh.md` where it exists)
- [ ] Install steps, a page, a source or a config format changed? `docs/installation.md`, `docs/faq.md` or the guide for it updated
- [ ] User-visible change: one line added under `## [Unreleased]` in `CHANGELOG.md` (see `RELEASING.md`)
- [ ] No secrets, personal data, real collected job ads or machine-specific paths
- [ ] Commit messages follow Conventional Commits
- [ ] Every commit is signed off (`git commit -s`, see the DCO section of `CONTRIBUTING.md`)
