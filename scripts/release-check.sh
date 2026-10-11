#!/usr/bin/env bash
# Checks to run before the repository is made public, or whenever you doubt a commit:
#   1. secrets      gitleaks (Docker image zricethezav/gitleaks, pinned version) over every file that git would track and,
#                   in a git checkout, over the whole commit history (all refs): a secret removed later is still public
#   2. personal     strings from the untracked local patterns file, plus machine paths and tailnet names, must not occur
#                   (in the generated pictures under docs/images/ the file names are checked too)
#   3. .gitignore   .env, data/ and .auth/ must be ignored
#   4. planning ids private planning ids (F-/B-/ADR- + three digits, M-/P- + two digits) must not occur in any file or file
#                   name, except drizzle/ and pnpm-lock.yaml at the root and the paths (or path:line) in scripts/planning-ids.allow
#
#   scripts/release-check.sh [--skip-gitleaks]
#   scripts/release-check.sh --planning-ids-only    (only check 4: fast, no Docker; scripts/validate.sh runs it)
#
# Exit code 0 = clean, 1 = something to fix (every finding is printed), 2 = the check could not run.
# Works in a git checkout (it looks at tracked + untracked-but-not-ignored files) and in a plain directory.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

SKIP_GITLEAKS=0
IDS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-gitleaks) SKIP_GITLEAKS=1 ;;
    --planning-ids-only) IDS_ONLY=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "release-check: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The gitleaks image is pinned: a moving tag would change the rules between two release checks.
GITLEAKS_IMAGE="${RELEASE_CHECK_GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.24.3}"
# Private planning ids (feature, bug, decision and milestone numbers of the maintainer's own records) do not belong in the
# repository. Not scanned: drizzle/ (generated migrations and their journal must not change), the lockfile, this script, the
# allowlist itself (all by exact location). Justified exceptions (an id that is data, not a reference) go into the allowlist, one
# path or path:line per line.
# ADR is matched in any case (adr-009); the one-letter prefixes only in capitals, because p-12 / m-10 are utility class names.
PLANNING_ID_REGEX='\b(F|B)-[0-9]{3}\b|\b[Aa][Dd][Rr]-[0-9]{3}\b|\b(M|P)-[0-9]{2}\b'
PLANNING_ID_ALLOWLIST="scripts/planning-ids.allow"

FAIL=0
fail() { echo "FAIL  $*"; FAIL=1; }
ok() { echo "ok    $*"; }

# Extra personal / machine-specific strings (one fixed string per line, "#" comments allowed) come from an untracked file:
# $RELEASE_CHECK_PATTERNS_FILE, or .release-check.local at the repository root. Without it only the generic checks run.
PATTERNS_FILE="${RELEASE_CHECK_PATTERNS_FILE:-$ROOT/.release-check.local}"
PERSONAL=()
if [[ -f "$PATTERNS_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    PERSONAL+=("$line")
  done < "$PATTERNS_FILE"
else
  echo "release-check: no local patterns file (.release-check.local or RELEASE_CHECK_PATTERNS_FILE); personal-string check limited to generic paths"
fi
# Generic machine paths are allowed when the name is one of these placeholders (tests and docs use them).
ALLOWED_PATH_NAMES='me|test|x|SSD|Other|Data|example|you|user|name|path|work|Library|System|<[^>]*>|\$[A-Za-z_]+'

# Check 4, also run alone by --planning-ids-only. Works on the staged copy of the files in scope.
check_planning_ids() {
  local allow_file="" hits names
  [[ -f "$STAGE/$PLANNING_ID_ALLOWLIST" ]] && allow_file="$STAGE/$PLANNING_ID_ALLOWLIST"
  # Not scanned, by exact location: drizzle/ and pnpm-lock.yaml at the root, this script and the allowlist.
  local scan=(-type f ! -path './drizzle/*' ! -path ./pnpm-lock.yaml ! -path ./scripts/release-check.sh ! -path ./scripts/planning-ids.allow)
  # file contents ("path:line:text") and file names ("path")
  hits="$(cd "$STAGE" && find . "${scan[@]}" -exec grep -HInE -- "$PLANNING_ID_REGEX" {} + | sed 's#^\./##' || true)"
  names="$(cd "$STAGE" && find . "${scan[@]}" | sed 's#^\./##' | grep -E -- "$PLANNING_ID_REGEX" | sed 's#$#: (file name)#' || true)"
  hits="$(printf '%s\n%s\n' "$hits" "$names" | sed '/^$/d')"
  if [[ -n "$hits" && -n "$allow_file" ]]; then
    # An allowlist line is "path" (every hit in that file, and the file name) or "path:LINE" (that line only); comments after "#".
    hits="$(printf '%s\n' "$hits" | awk -v allow="$allow_file" '
      BEGIN { while ((getline l < allow) > 0) { sub(/#.*/, "", l); gsub(/[[:space:]]/, "", l); if (l != "") ok[l] = 1 } }
      { path = $0; sub(/:.*/, "", path)
        n = split($0, parts, ":"); ln = (n >= 2 && parts[2] ~ /^[0-9]+$/) ? parts[2] : ""
        if (path in ok || (ln != "" && (path ":" ln) in ok)) next
        print }')"
  fi
  if [[ -n "$hits" ]]; then
    fail "private planning ids (F-/B-/ADR- + 3 digits, M-/P- + 2 digits) in file contents or file names; reword, or list a path (or path:line) whose id is data in $PLANNING_ID_ALLOWLIST:"
    echo "$hits" | sed 's/^/      /'
  else
    ok "no private planning ids in the repository"
  fi
}

# ---- the files git would track --------------------------------------------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -co --exclude-standard -z
  else
    find . -type f \
      -not -path './node_modules/*' -not -path './.next/*' -not -path './data/*' -not -path './.git/*' \
      -not -path './.auth/*' -not -path './dist/*' -not -path './.venv/*' -not -name '.env' -not -name '.env.local' -print0 | perl -0pe 's#(^|\0)\./#$1#g'
  fi
}
list_files | while IFS= read -r -d '' f; do [[ -f "$f" ]] && printf '%s\0' "$f"; done | tar --null -T - -cf - | tar -xf - -C "$STAGE"
COUNT="$(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo "release-check: $COUNT files in scope"

if [[ "$IDS_ONLY" -eq 1 ]]; then
  check_planning_ids
  echo
  if [[ "$FAIL" -eq 0 ]]; then echo "release-check: planning ids clean"; else echo "release-check: problems found (see FAIL lines)"; fi
  exit "$FAIL"
fi

# ---- 1. gitleaks -------------------------------------------------------------------------------------------------------
if [[ "$SKIP_GITLEAKS" -eq 1 ]]; then
  echo "skip  gitleaks (--skip-gitleaks)"
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "release-check: Docker is not available, so gitleaks cannot run (use --skip-gitleaks to skip it knowingly)" >&2
  exit 2
else
  cfg=(); [[ -f "$STAGE/.gitleaks.toml" ]] && cfg=(--config /repo/.gitleaks.toml)
  if out="$(docker run --rm -v "$STAGE:/repo:ro" "$GITLEAKS_IMAGE" detect --no-git --source /repo ${cfg[@]+"${cfg[@]}"} --redact --verbose --no-banner 2>&1)"; then
    ok "gitleaks found no secrets in the files"
  else
    status=$?
    if [[ "$status" -eq 1 ]]; then fail "gitleaks reported secrets:"; echo "$out" | sed 's/^/      /'; else echo "$out" >&2; echo "release-check: gitleaks could not run" >&2; exit 2; fi
  fi
  # the whole history, every ref: scanned in a throw-away mirror clone (works from a worktree too); the config comes from the working tree
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git clone --quiet --mirror --no-hardlinks "$ROOT" "$STAGE.history.git" || { echo "release-check: could not clone the history for the scan" >&2; exit 2; }
    trap 'rm -rf "$STAGE" "$STAGE.history.git"' EXIT
    hcfg=(); hmount=(); [[ -f "$ROOT/.gitleaks.toml" ]] && { hcfg=(--config /cfg/.gitleaks.toml); hmount=(-v "$ROOT/.gitleaks.toml:/cfg/.gitleaks.toml:ro"); }
    if out="$(docker run --rm -v "$STAGE.history.git:/repo:ro" ${hmount[@]+"${hmount[@]}"} -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' "$GITLEAKS_IMAGE" detect --source /repo --log-opts="--all" ${hcfg[@]+"${hcfg[@]}"} --redact --verbose --no-banner 2>&1)"; then
      ok "gitleaks found no secrets in the commit history ($(git rev-list --all --count) commits)"
    else
      status=$?
      if [[ "$status" -eq 1 ]]; then fail "gitleaks reported secrets in the commit history:"; echo "$out" | sed 's/^/      /'; else echo "$out" >&2; echo "release-check: gitleaks could not scan the history" >&2; exit 2; fi
    fi
  else
    echo "skip  gitleaks history scan (not a git checkout)"
  fi
fi

# ---- 2. personal information -------------------------------------------------------------------------------------------
found=0
for needle in ${PERSONAL[@]+"${PERSONAL[@]}"}; do
  hits="$(cd "$STAGE" && grep -rIn --exclude=pnpm-lock.yaml --exclude=release-check.sh --exclude=.release-check.local -F -- "$needle" . || true)"
  if [[ -n "$hits" ]]; then fail "personal string '$needle':"; echo "$hits" | sed 's/^/      /'; found=1; fi
done
# user and volume paths of a real machine, and tailnet host names
paths="$(cd "$STAGE" && grep -rIn --exclude=pnpm-lock.yaml --exclude=release-check.sh -E '/(Users|Volumes)/[A-Za-z0-9._-]+' -o . \
  | grep -Ev "/(Users|Volumes)/($ALLOWED_PATH_NAMES)\$" | grep -Ev '/System/Volumes/' || true)"
if [[ -n "$paths" ]]; then fail "machine paths (add a placeholder name to ALLOWED_PATH_NAMES if it is generic):"; echo "$paths" | sed 's/^/      /'; found=1; fi
# only the documented placeholders pass; a real tailnet id never does
hosts="$(cd "$STAGE" && grep -rIn --exclude=pnpm-lock.yaml --exclude=release-check.sh -E '[A-Za-z0-9-]+\.ts\.net' . | grep -Ev '<[^>]*>\.ts\.net|MACHINE\.TAILNET\.ts\.net|[a-z]+\.example(-tailnet|-other)?\.ts\.net' || true)"
if [[ -n "$hosts" ]]; then fail "tailnet host names:"; echo "$hosts" | sed 's/^/      /'; found=1; fi
# the generated pictures (docs/images/): grep skips binary files, so check their names too
if [[ -d "$STAGE/docs/images" ]]; then
  image_names="$(cd "$STAGE" && find docs/images -type f)"
  for needle in ${PERSONAL[@]+"${PERSONAL[@]}"}; do
    hits="$(printf '%s\n' "$image_names" | grep -iF -- "$needle" || true)"
    if [[ -n "$hits" ]]; then fail "personal string '$needle' in an image file name:"; echo "$hits" | sed 's/^/      /'; found=1; fi
  done
  odd="$(printf '%s\n' "$image_names" | grep -Ev '^docs/images/(README\.md|([a-z0-9-]+/)*[a-z0-9.-]+\.(png|gif|webp|svg))$' || true)"
  if [[ -n "$odd" ]]; then fail "image file names must be lower-case words, digits and dashes (png/gif/webp/svg):"; echo "$odd" | sed 's/^/      /'; found=1; fi
fi
[[ "$found" -eq 0 ]] && ok "no personal strings or machine paths"

# ---- 3. .gitignore -----------------------------------------------------------------------------------------------------
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for p in .env .env.local data/config/x.yaml data/backups/x.dump .auth/state.json; do
    if git check-ignore -q "$p"; then ok ".gitignore covers $p"; else fail ".gitignore does not cover $p"; fi
  done
  if git check-ignore -q .env.example; then fail ".env.example is ignored but must be tracked"; fi
else
  for pat in '^\.env' '^/?data/?' '^/?\.auth/?'; do
    if grep -Eq "$pat" .gitignore 2>/dev/null; then ok ".gitignore has a line matching $pat"; else fail ".gitignore has no line matching $pat"; fi
  done
fi
# only the empty .gitkeep markers of data/ and .auth/ may be tracked (they make a clone create the directories)
for tracked in .env data/config .auth; do
  if [[ -n "$(cd "$STAGE" && find . \( -path "./$tracked" -o -path "./$tracked/*" \) ! -type d ! -name .gitkeep | head -1)" ]]; then fail "$tracked is in scope for the repository"; fi
done

# ---- 4. private planning ids ----------------------------------------------------------------------------------------------
check_planning_ids

echo
if [[ "$FAIL" -eq 0 ]]; then echo "release-check: clean"; else echo "release-check: problems found (see FAIL lines)"; fi
exit "$FAIL"
