# Releasing

Maintainer-facing notes on versioning, the changelog and how a release is cut. Contributors only need the
[changelog rule](#changelog-conventions).

## Versioning

Job Radar follows [Semantic Versioning](https://semver.org/). The version is the `version` field in `package.json`;
a release is a git tag `vX.Y.Z` on the commit that bumps it, plus a GitHub Release.

| Bump | When |
|---|---|
| MAJOR | A change that needs the user to act when upgrading: a breaking configuration, data or CLI change |
| MINOR | New features and non-breaking improvements |
| PATCH | Bug fixes, documentation and dependency updates that change no behaviour |

### What counts as breaking

- **Configuration**: a changed or removed key, or a changed meaning, in a way that `pnpm config:migrate` cannot upgrade
  silently. Anything that needs a new `config_version` and a manual step is breaking; a migration that runs on its own
  and keeps the old behaviour is not.
- **Data**: a database migration that cannot be applied automatically, drops data, or cannot be rolled back from the
  pre-deploy backup.
- **CLI and scripts**: removing or renaming a `pnpm` script, a flag of `scripts/ops/*`, or an environment variable
  documented in `.env.example`.
- **Docker and compose**: renaming services, volumes or ports that existing installs depend on.

When in doubt, treat it as breaking and say what the user has to do in the changelog entry.

## Changelog conventions

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): newest first, one section per
release (`## [X.Y.Z] - YYYY-MM-DD`), with `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security` groups.
Entries are written for users: what changed and what they have to do, in plain English, without internal ticket ids.

- **Contributors** add one line under `## [Unreleased]` in their pull request, in the matching group. Skip it only for
  changes users cannot notice (tests, CI, refactors); say so in the PR.
- **Maintainers** turn `[Unreleased]` into the new version section at release time, tidy the wording, and leave an
  empty `## [Unreleased]` on top. Breaking changes get a bold **Breaking** prefix and upgrade steps.

## Release steps

1. **Merge everything that belongs in the release.** All PRs merged, CI green on `main` (what the pipeline checks: [docs/ci.md](docs/ci.md)). Run `scripts/validate.sh`,
   `pnpm test:integration` and, for a minor or major, `pnpm test:e2e` on `main`.
   Run `git fetch --all --tags` and then `scripts/release-check.sh` (so the history scan sees every remote ref): it scans the files **and the whole commit history** for secrets (gitleaks, pinned
   image version, needs Docker), looks for personal strings and machine paths, and fails on private planning ids
   (`F-`, `B-`, `ADR-` and three digits, `M-`, `P-` and two digits, as in the maintainer's tracker) anywhere in the repository. Fix every finding before tagging.
2. **Deploy and check.** Deploy `main` on your own instance (`scripts/ops/deploy.sh`), avoiding processing rounds, then
   run `pnpm run doctor` and confirm everything is green. For a minor or major release, click through the main flows
   once (today, jobs, applications, sources, settings).
3. **Version bump PR.** Move `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`, bump `version` in `package.json`, and merge
   the PR with the title `chore: release vX.Y.Z`.
4. **Tag.** On the merge commit of that PR, create a **signed annotated tag** and push it:
   `git tag -s vX.Y.Z -m "vX.Y.Z"`, then `git tag -v vX.Y.Z` as the pass/fail check (do not push if it fails), then `git push origin vX.Y.Z`. Signing needs a GPG or SSH signing key
   configured in git (`git config user.signingkey`, plus `gpg.format ssh` for an SSH key) whose public part is published
   (in the repository as `docs/signing-key.pub`, which `deploy.sh --verify` uses, and on the maintainer's GitHub account). If no signing key is available, fall back to
   `git tag -a vX.Y.Z -m "vX.Y.Z"` and say in the release notes that this tag is unsigned. The guide links in the web
   interface point at `blob/vX.Y.Z/docs/...` of the running version, so they work only once this tag is pushed.
5. **GitHub Release.** Create a release from the tag; paste the changelog section as the notes and call out upgrade
   steps for breaking changes. Mark pre-releases (`vX.Y.Z-rc.N`) as such.
6. **Docker and compose.** The stack is built from the checkout (`docker compose up -d --build`), so no image is
   published. Users upgrade with `scripts/ops/deploy.sh --ref vX.Y.Z` ([docs/upgrade.md](docs/upgrade.md)), which checks out the tag, backs up
   the database first and runs config and database migrations. If a release changes compose services or volumes, say
   so in the notes.

### Hotfix

Branch from `main`, fix, and release a PATCH with the same steps minus the manual click-through. Backport only if an
older supported line is affected (see below).

## Support policy

Only the latest MINOR release line (`X.Y.*`) receives fixes. Security fixes are released as a PATCH of that line as
soon as they are ready; see [SECURITY.md](SECURITY.md) for reporting. Upgrade to the latest minor before asking for
help with a bug.
