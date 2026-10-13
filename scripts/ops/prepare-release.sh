#!/usr/bin/env bash
# Build the read-only release directory of the host ai-worker for one commit:
#
#   scripts/ops/prepare-release.sh <sha> --root <main> [--offline]
#
#   <sha>          the commit, as 40 lowercase hex digits; the release is <main>/data/releases/ai-worker/<sha>/
#   --root <main>  the checkout (absolute path) that holds the commit and the data/ directory
#   --offline      pnpm install --offline instead of --prefer-offline (tests: the pnpm store must already hold everything)
#   -h, --help     print this help
#
# Before anything is changed: data/releases and data/releases/ai-worker must not be symbolic links (when they exist), and
# neither may the release path itself.
#
# Steps, all under the release lock data/releases/ai-worker/.lock (taken here, or re-entered with the token a calling
# script exported in JOB_RADAR_RELEASES_LOCK_TOKEN):
#   1  an existing release with a valid .release.json (sha, tree of <sha>, sha256 of pnpm-lock.yaml) is reused as is;
#      one with an invalid marker is renamed to .trash-<sha>-<pid> and removed, unless the installed worker may run
#      from it. That is asked of install-ai-worker.sh --print-release (next to this script, a regular file, not a
#      link): exit 0 names the release in use (refused when it is this one), 3 (not installed, or only under the legacy
#      label) and 4 (installed, not from a release directory) let the rebuild go on, and 1 or any other exit refuses
#      (the script cannot tell). An install script that does not mention --print-release at all predates release
#      directories; it is not run, and the rebuild goes on only when the installed service definition (found by the
#      ai-worker identity rules, read as a file) does not mention data/releases/ai-worker/ (a worker installed by a
#      newer checkout may run from a release). Anything that cannot be read refuses.
#   2  git archive of <sha> into .tmp-<sha>-<pid>/ next to the releases
#   3  `pnpm --version` must equal the packageManager of that commit (else: run `corepack enable`)
#   4  pnpm install --frozen-lockfile --prod --prefer-offline --ignore-scripts: no lifecycle script runs at all, not even
#      one that allowBuilds of pnpm-workspace.yaml would allow; a commit without tsx in its dependencies gets the full
#      install instead
#   5  node_modules/tsx/dist/loader.mjs exists; .release.json is written: sha, tree, lockfile_sha256, prod_only, created
#   6  every archived file except symbolic links (chmod would change the link's target), .release.json and every
#      directory lose their write bits (files under node_modules keep their mode: they may be hard links into the pnpm
#      store)
#   7  published with mv, only to a path that does not exist yet
# stdout gets exactly one line on success, the release directory; everything else goes to stderr.
#
# Exit code: 0 = the release is ready (built or reused); 1 = failed or refused (lock held, pnpm version mismatch, a
# broken release that is or may be in use, a symbolic link on the release path, the lock kept at release because a descendant's exit is not confirmed). Interrupted
# (INT, TERM, HUP): the running step finishes in its own process group, no further step starts, the lock this script
# took is released, its .tmp directory removed, and the exit code is 130, 143 or 129. Re-entered under a caller's lock,
# the script never removes its .tmp directory: the next deploy that holds the lock sweeps it.
set -euo pipefail

OPS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# The header comment above (line 2 up to the first line that is not a comment); tests/ops/script-help.test.ts checks it names every option.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
say() { echo "prepare-release: $*" >&2; }
die() { say "$*"; exit 1; }

SHA=""
MAIN=""
OFFLINE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) [[ $# -ge 2 && -n "$2" ]] || die "--root needs a path"; MAIN="$2"; shift ;;
    --offline) OFFLINE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown argument: $1 (try --help)" ;;
    *) [[ -z "$SHA" ]] || die "only one commit, got '$SHA' and '$1'"; SHA="$1" ;;
  esac
  shift
done
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "the commit must be 40 lowercase hex digits (git rev-parse <commit>), got '${SHA}'"
[[ -n "$MAIN" ]] || die "--root <main> is required"
while [[ "$MAIN" == */ && "$MAIN" != / ]]; do MAIN="${MAIN%/}"; done
[[ "$MAIN" == /* && "$MAIN" != / ]] || die "--root needs an absolute path, got '$MAIN'"
[[ -d "$MAIN" ]] || die "--root $MAIN is not a directory"
git -C "$MAIN" cat-file -e "$SHA^{commit}" 2>/dev/null || die "$SHA is not a commit of $MAIN"

# shellcheck source=lib/proc.sh
source "$OPS/lib/proc.sh"
PROC_RC_ALLOWED="0 1 2"
# shellcheck source=lib/releases.sh
source "$OPS/lib/releases.sh"
# shellcheck source=lib/ai-worker.sh
source "$OPS/lib/ai-worker.sh"

RDIR="$(releases_dir "$MAIN")"
DEST="$RDIR/$SHA"
TMP_DIR=""     # this run's .tmp-<sha>-<pid>, removed by on_exit only when this run took the lock and released it
CLEANED=""

on_exit() {
  local rc=$? mine lrc
  set +e
  [[ -n "$CLEANED" ]] && return; CLEANED=1
  [[ -z "$PROC_PGID" ]] || proc_group_wait "$PROC_PGID"
  mine="$RELEASES_LOCK_MINE"; lrc=0; releases_lock_release "$MAIN" || lrc=$?
  (( lrc == 3 )) && rc=1
  if [[ "$mine" == 1 && "$lrc" == 0 && -n "$TMP_DIR" ]]; then release_rm "$MAIN" "$TMP_DIR"; fi
  exit "$(proc_exit_rc "$rc")"
}
proc_traps on_exit

# A state-changing step: in its own process group; a signal recorded meanwhile stops the script before the next step.
run_step() { local rc; proc_check_stop; rc=0; proc_run "$@" || rc=$?; proc_check_stop; return "$rc"; }

# installed_release: sets INSTALLED_RELEASE to the release directory the installed worker runs from, empty when it runs
# from none (see step 1 in the header). Returns 1, with the reason on stderr, when that cannot be told.
INSTALLED_RELEASE=""
installed_release() {
  local install="$OPS/install-ai-worker.sh" out rc=0 grc=0
  INSTALLED_RELEASE=""
  if [[ -L "$install" || ! -f "$install" ]]; then
    say "cannot tell which release the installed ai-worker runs from: $install is missing, a symbolic link or not a regular file"
    return 1
  fi
  grep -qF -- '--print-release' "$install" || grc=$?
  case "$grc" in
    0) ;;
    1) installed_definition_without_release; return ;;   # an install script from before release directories
    *) say "cannot tell which release the installed ai-worker runs from: cannot read $install (grep exited $grc)"; return 1 ;;
  esac
  out="$(bash "$install" --print-release --root "$MAIN" </dev/null)" || rc=$?
  case "$rc" in
    0) if [[ "$out" != /* || "$out" == *$'\n'* ]]; then
         say "cannot tell which release the installed ai-worker runs from: install-ai-worker.sh --print-release printed '$out', not one absolute path"
         return 1
       fi
       INSTALLED_RELEASE="$out" ;;
    3|4) ;;
    *) say "cannot tell which release the installed ai-worker runs from: install-ai-worker.sh --print-release exited $rc"; return 1 ;;
  esac
  return 0
}
# installed_definition_without_release: 0 when no ai-worker definition is installed, or the installed one does not
# mention data/releases/ai-worker/ (its worker runs from a checkout). 1, with the reason, otherwise or when it cannot be read.
installed_definition_without_release() {
  local ident def grc=0
  if ! ident="$(ai_worker_identity "$MAIN")"; then
    say "cannot tell which release the installed ai-worker runs from: its service identity is ambiguous (see above)"
    return 1
  fi
  def="$(printf '%s\n' "$ident" | sed -n 's/^found_definition=//p')"
  [[ -n "$def" ]] || return 0
  grep -qF -- 'data/releases/ai-worker/' "$def" || grc=$?
  case "$grc" in
    0) say "cannot tell which release the installed ai-worker runs from: its definition $def names a release directory, and install-ai-worker.sh here predates --print-release"
       return 1 ;;
    1) return 0 ;;
    *) say "cannot tell which release the installed ai-worker runs from: cannot read $def (grep exited $grc)"; return 1 ;;
  esac
}
same_dir() { [[ "$1" == "$2" ]] || { [[ -d "$1" && -d "$2" ]] && [[ "$(cd "$1" && pwd -P)" == "$(cd "$2" && pwd -P)" ]]; }; }

if proc_tostop_set; then
  die "the terminal has tostop set: the steps run in the background and would stop at their first output; run stty -tostop, then retry"
fi

# ---- before anything changes: no symbolic link on the release path ---------------------------------------------------
for p in "$MAIN/data/releases" "$RDIR"; do
  [[ ! -L "$p" ]] || die "$p is a symbolic link; refusing to build releases through it (nothing was changed)"
done
release_path_ok "$MAIN" "$DEST" || die "$DEST is a symbolic link or sits under one; refusing to use or replace it (nothing was changed)"

# ---- 0: lock ------------------------------------------------------------------------------------------------------------
LOCK_DIR="$(releases_lock_dir "$MAIN")"
if ! releases_lock_acquire "$MAIN"; then
  if [[ "$RELEASES_LOCK_PARTIAL" != 1 && "$RELEASES_LOCK_INIT_FAILED" != 1 && "$RELEASES_LOCK_VANISHED" != 1 && -e "$LOCK_DIR" ]]; then
    releases_lock_report "$MAIN" >&2
  fi
  die "could not take the release lock $LOCK_DIR (see above); nothing was changed"
fi
releases_inflight_register "$MAIN" prepare-release || die "could not write the in-flight record under $LOCK_DIR"

# ---- 1: an existing release -----------------------------------------------------------------------------------------
if [[ -e "$DEST" || -L "$DEST" ]]; then
  release_path_ok "$MAIN" "$DEST" || die "$DEST is a symbolic link or sits under one; refusing to use or replace it"
  if [[ -d "$DEST" ]] && release_marker_valid "$DEST" "$SHA"; then
    say "reusing $DEST (valid .release.json)"
    printf '%s\n' "$DEST"
    exit 0
  fi
  installed_release || die "$DEST has no valid .release.json and the installed ai-worker may run from it; left in place"
  if [[ -n "$INSTALLED_RELEASE" ]] && same_dir "$INSTALLED_RELEASE" "$DEST"; then
    die "$DEST has no valid .release.json but the installed ai-worker runs from it; left in place (reinstall the worker from another release first)"
  fi
  trash="$RDIR/.trash-$SHA-$$"
  if [[ -e "$trash" || -L "$trash" ]]; then release_rm "$MAIN" "$trash" || die "could not remove the leftover $trash"; fi
  say "$DEST has no valid .release.json: rebuilding it"
  run_step mv -- "$DEST" "$trash" || die "could not move $DEST aside"
  release_rm "$MAIN" "$trash" || die "could not remove $trash (the next deploy holding the lock removes it)"
fi

# ---- 2: git archive ---------------------------------------------------------------------------------------------------
tmp="$RDIR/.tmp-$SHA-$$"
if [[ -e "$tmp" || -L "$tmp" ]]; then release_rm "$MAIN" "$tmp" || die "could not remove the leftover $tmp"; fi
mkdir "$tmp" || die "could not create $tmp"
TMP_DIR="$tmp"
say "git archive $SHA into $tmp"
# shellcheck disable=SC2016  # expanded by the inner bash
run_step bash -o pipefail -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$MAIN" "$SHA" "$tmp" \
  || die "git archive of $SHA failed"

# ---- 3: pnpm version --------------------------------------------------------------------------------------------------
want="$(sed -n -E 's/^[[:space:]]*"packageManager":[[:space:]]*"pnpm@([0-9]+\.[0-9]+\.[0-9]+)([+][^"]*)?"[[:space:]]*,?[[:space:]]*$/\1/p' "$tmp/package.json" | head -n 1)"
[[ -n "$want" ]] || die "package.json of $SHA has no packageManager \"pnpm@X.Y.Z\""
have="$(cd "$tmp" && pnpm --version 2>/dev/null </dev/null)" || have=""
have="${have//[[:space:]]/}"
[[ "$have" == "$want" ]] || die "pnpm ${have:-(not found)} does not match packageManager pnpm@$want of $SHA; run corepack enable (or install pnpm $want), then retry"

# ---- 4: install ---------------------------------------------------------------------------------------------------------
store_mode="--prefer-offline"; [[ "$OFFLINE" == 0 ]] || store_mode="--offline"
tsx_dep=0
node -e 'const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.exit(p.dependencies && typeof p.dependencies.tsx === "string" ? 0 : 3)' "$tmp/package.json" || tsx_dep=$?
case "$tsx_dep" in
  0) prod_only=true; install=(pnpm install --frozen-lockfile --prod "$store_mode" --ignore-scripts) ;;
  3) prod_only=false; install=(pnpm install --frozen-lockfile "$store_mode" --ignore-scripts)
     say "tsx is not in the dependencies of $SHA (an older commit): full install, dev dependencies included" ;;
  *) die "could not read package.json of $SHA" ;;
esac
say "${install[*]} (in $tmp)"
# shellcheck disable=SC2016  # expanded by the inner bash
run_step bash -c 'cd -- "$1" || exit 1; shift; exec "$@" >&2' _ "$tmp" "${install[@]}" || die "pnpm install failed in $tmp"

# ---- 5: loader and marker -----------------------------------------------------------------------------------------
[[ -f "$tmp/node_modules/tsx/dist/loader.mjs" ]] || die "node_modules/tsx/dist/loader.mjs is missing after the install"
tree="$(git -C "$MAIN" rev-parse --verify "$SHA^{tree}")" || die "could not read the tree of $SHA"
[[ -f "$tmp/pnpm-lock.yaml" ]] || die "$SHA has no pnpm-lock.yaml"
lock_sum="$(releases_sha256 "$tmp/pnpm-lock.yaml")" || die "could not hash pnpm-lock.yaml"
printf '{\n  "sha": "%s",\n  "tree": "%s",\n  "lockfile_sha256": "%s",\n  "prod_only": %s,\n  "created": "%s"\n}\n' \
  "$SHA" "$tree" "$lock_sum" "$prod_only" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp/.release.json" || die "could not write .release.json"

# ---- 6: read-only -----------------------------------------------------------------------------------------------------
# shellcheck disable=SC2016  # expanded by the inner bash
run_step bash -o pipefail -c '
  set -e
  # every tracked path but symbolic links (mode 120000): chmod follows a link and would change its target
  git -C "$1" ls-tree -r -z "$2" | while IFS= read -r -d "" rec; do
    [[ "${rec%% *}" == 120000 ]] || printf "%s\0" "${rec#*$'\''\t'\''}"
  done | (cd "$3" && xargs -0 chmod a-w)
  chmod a-w "$3/.release.json"
  find -P "$3" -type d -exec chmod a-w {} +' _ "$MAIN" "$SHA" "$tmp" || die "could not make $tmp read-only"
[[ ! -w "$tmp" && ! -w "$tmp/.release.json" && ! -w "$tmp/package.json" ]] || die "$tmp is still writable after chmod"

# ---- 7: publish -------------------------------------------------------------------------------------------------------
proc_check_stop
[[ ! -e "$DEST" && ! -L "$DEST" ]] || die "$DEST appeared while building; left both in place"
run_step mv -- "$tmp" "$DEST" || die "could not move $tmp to $DEST"
TMP_DIR=""
[[ -f "$DEST/.release.json" && ! -e "$DEST/${tmp##*/}" ]] || die "publishing $DEST failed: .release.json is not where it should be"
say "ready: $DEST"
printf '%s\n' "$DEST"
