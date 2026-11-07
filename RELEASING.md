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

Starting with 2.1.0, `main` stays the development branch and `stable` is the GitHub default branch, so a plain clone
lands on the newest release. `stable` only moves forward when a release is tagged; never force-push it.

1. **Merge everything that belongs in the release into `main`.** CI must be green (what the pipeline checks:
   [docs/ci.md](docs/ci.md)). Run `scripts/validate.sh`, `pnpm test:integration` and, for a minor or major,
   `pnpm test:e2e` on `main`. Run `git fetch --all --tags` and then `scripts/release-check.sh` (so the history scan
   sees every remote ref): it scans the files **and the whole commit history** for secrets (gitleaks, pinned image
   version, needs Docker), looks for personal strings and machine paths, and fails on private planning ids anywhere
   in the repository. Fix every finding before tagging.
2. **Version bump PR.** Move `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`, leave an empty `[Unreleased]` section,
   bump `version` in `package.json`, and merge the PR titled `chore: release vX.Y.Z` into `main`.
3. **Deploy and observe that commit.** Deploy the merge commit of the bump PR on your own instance
   (`git switch --detach <merge commit>`, then `scripts/ops/deploy.sh --skip-pull`), avoiding processing rounds.
   Observe it for **at least 24 hours**, with **at least one finished processing round** and a green `pnpm run doctor`.
   For a minor or major release,
   click through the main flows once (today, jobs, applications, sources, settings).
4. **Tag the observed commit.** Check out that exact commit, create a **signed annotated tag** and push it:
   `git tag -s vX.Y.Z -m "vX.Y.Z"`, then `git tag -v vX.Y.Z` as the pass/fail check (do not push if it fails),
   then `git push origin vX.Y.Z`. Signing needs a GPG or SSH signing key configured in git
   (`git config user.signingkey`, plus `gpg.format ssh` for an SSH key) whose public part is published
   (in the repository as `docs/signing-key.pub`, which `deploy.sh --verify` uses, and on the maintainer's GitHub
   account). The guide links in the web interface point at `blob/vX.Y.Z/docs/...` of the running version, so they
   work only once this tag is pushed.
5. **GitHub Release.** Create a release from the tag; paste the changelog section as the notes and call out upgrade
   steps for breaking changes. Mark pre-releases (`vX.Y.Z-rc.N`) as such.
6. **Advance `stable`.** Starting with 2.1.0, fast-forward `stable` to the release tag:
   `git push origin vX.Y.Z^{commit}:refs/heads/stable`. Never force-push.

**Docker and compose.** The stack is built from the checkout (`docker compose up -d --build`), so no image is
published. Users upgrade with `scripts/ops/deploy.sh --ref vX.Y.Z` ([docs/upgrade.md](docs/upgrade.md)), which checks
out the tag, backs up the database first and runs config and database migrations. If a release changes compose
services or volumes, say so in the notes.

### Hotfix

Starting with 2.1.0, use this manual procedure for a PATCH of the supported release line (see below):

1. Branch `hotfix/X.Y.Z` from the release tag being fixed, for example `v2.1.0` for hotfix `2.1.1`:
   `git switch -c hotfix/2.1.1 v2.1.0`.
2. Open the fix PR against that hotfix branch, including the version and changelog update. Run the applicable checks
   above and test the merged commit on a **separate preview instance**, instead of the 24-hour observation on the
   production instance.
3. Sign the tag on that tested commit, verify it with `git tag -v vX.Y.Z`, push it and publish the GitHub Release by
   hand, with the signing and release-note details above.
4. Bring the same fix into `main` in its own PR.
5. Fetch `origin/stable`. If it can fast-forward to the hotfix tag, push the tag's commit as in the release steps.
   Only if it cannot fast-forward, create a merge commit with the hotfix tag's tree and both parents, then push it:

   ```bash
   git fetch origin stable
   git commit-tree 'vX.Y.Z^{tree}' -p origin/stable -p 'vX.Y.Z^{commit}' -m "Merge hotfix vX.Y.Z into stable"
   git push origin <that commit>:refs/heads/stable
   ```

   Use the commit printed by `git commit-tree` as `<that commit>`. This keeps the hotfix's files while `stable` only
   moves forward; never force-push.

## Support policy

Only the latest MINOR release line (`X.Y.*`) receives fixes. Security fixes are released as a PATCH of that line as
soon as they are ready; see [SECURITY.md](SECURITY.md) for reporting. Upgrade to the latest minor before asking for
help with a bug.
