#!/usr/bin/env bash
# Checks that nothing .gitignore ignores can reach a Docker build context taken from the working tree
# (`pnpm stack:up`, a plain `docker compose build`): a real docker build lists its context.
#
#   tests/ops/gitignore-coverage.sh            needs git and a running Docker; runs in CI (linux-smoke)
#   NODE_VERSION=22 tests/ops/gitignore-coverage.sh
#
# Expansion rule, for every entry of .gitignore (comments and blank lines skipped):
#   - a negation (!...) re-includes files, so it has no sample; it must be in ALLOWLIST below, with its reason;
#   - every `*` becomes a concrete name unique to the entry (x<entry number>), a trailing `/` marks a directory, a
#     leading `/` is dropped;
#   - root sample: the entry itself at the root (a directory entry gets a file inside it: <dir>/sample.txt);
#   - subdirectory sample: an entry without a `/` (other than a trailing one) matches at any depth, so the same
#     sample under sub/dir/; an anchored entry (with a `/`) matches only at the root, so a file nested deeper inside
#     it: <path>/nested/sample.txt.
# The root samples and the subdirectory samples go into two separate contexts (an anchored file entry's two samples
# could not both exist in one tree). Each sample is first checked with `git check-ignore` (a sample git does not
# ignore means this rule is wrong), then each context is listed with tests/fixtures/docker/context-list.Dockerfile
# and must contain none of its samples.
# The samples live in a temporary directory with copies of .gitignore and .dockerignore, never in the checkout
# (a real .env or data/ there is never touched). Nothing is tagged; the built images are removed by their IDs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Entries that need no sample, each with its reason. The key is the line exactly as it is in .gitignore.
ALLOWLIST_KEYS=(
  '!.env.example'
  '!/.auth/.gitkeep'
  '!/data/config/'
  '!/data/profile/'
  '!/data/backups/'
  '!/data/exports/'
  '!/data/logs/'
  '!/data/*/.gitkeep'
)
ALLOWLIST_REASONS=(
  'negation: the tracked template of .env; it holds no secret and may be in the context'
  'negation: the tracked empty marker of .auth/ (.dockerignore excludes all of .auth)'
  'negation: keeps the data/config directory marker tracked (.dockerignore excludes all of data)'
  'negation: keeps the data/profile directory marker tracked (.dockerignore excludes all of data)'
  'negation: keeps the data/backups directory marker tracked (.dockerignore excludes all of data)'
  'negation: keeps the data/exports directory marker tracked (.dockerignore excludes all of data)'
  'negation: keeps the data/logs directory marker tracked (.dockerignore excludes all of data)'
  'negation: the tracked empty markers under data/ (.dockerignore excludes all of data)'
)

fail() { echo "FAIL: $*" >&2; exit 1; }
for tool in git docker grep sed mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "missing $tool"; done
docker info >/dev/null 2>&1 || fail "Docker is not running"

if [[ -z "${NODE_VERSION:-}" ]]; then
  NODE_VERSION="$(sed -n 's/^ARG NODE_VERSION=//p' "$REPO/Dockerfile" | head -n 1)"
fi
[[ "$NODE_VERSION" =~ ^[0-9][0-9.]*$ ]] || fail "cannot read NODE_VERSION from the Dockerfile"

TMP="$(mktemp -d)"
# The listings run in command substitutions (subshells), so the image IDs are read back from their --iidfile files here.
cleanup() {
  local f id
  for f in "$TMP"/*.iid; do
    [[ -f "$f" ]] || continue
    id="$(cat "$f" 2>/dev/null || true)"
    [[ -z "$id" ]] || docker image rm -f "$id" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

allowed() {   # allowed <entry>: 0 and prints the reason when the entry is in the allowlist
  local i
  for i in "${!ALLOWLIST_KEYS[@]}"; do
    if [[ "${ALLOWLIST_KEYS[$i]}" == "$1" ]]; then echo "${ALLOWLIST_REASONS[$i]}"; return 0; fi
  done
  return 1
}

new_context() {   # new_context <dir>: copies of .gitignore / .dockerignore, a git repo, the two control files
  mkdir -p "$1"
  cp "$REPO/.gitignore" "$REPO/.dockerignore" "$1/"
  git -C "$1" init -q
  echo marker > "$1/marker.txt"
  echo "# template" > "$1/.env.example"
}
ROOT_CTX="$TMP/root" SUB_CTX="$TMP/sub"
new_context "$ROOT_CTX"
new_context "$SUB_CTX"

root_samples=() sub_samples=()
add_sample() {   # add_sample <context> <relative path> <entry>: creates the file and checks that git ignores it
  mkdir -p "$1/$(dirname "$2")"
  echo sample > "$1/$2"
  git -C "$1" check-ignore -q --no-index "$2" || fail "the expansion of '$3' gave $2, which git does not ignore"
}

entries=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue
  entries=$((entries + 1))
  if [[ "$line" == '!'* ]]; then
    reason="$(allowed "$line")" || fail "negation '$line' in .gitignore is not in the allowlist of $0 (add it with a reason)"
    echo "allowlisted: $line ($reason)"
    continue
  fi
  entry="$line" dir=0 anchored=0
  if [[ "$entry" == */ ]]; then dir=1; entry="${entry%/}"; fi
  if [[ "$entry" == */* ]]; then anchored=1; entry="${entry#/}"; fi
  path="${entry//\*/x$entries}"
  if (( dir )); then root="$path/sample.txt"; else root="$path"; fi
  if (( anchored )); then sub="$path/nested/sample.txt"; else sub="sub/dir/$root"; fi
  add_sample "$ROOT_CTX" "$root" "$line"; root_samples+=("$root")
  add_sample "$SUB_CTX" "$sub" "$line"; sub_samples+=("$sub")
done < "$REPO/.gitignore"
(( entries > 0 )) || fail "no entries read from .gitignore"

# list_context <dir> <name>: prints the paths in the build context of <dir>, one per line (/ctx/...)
list_context() {
  local log="$TMP/$2.log"
  if ! docker build --no-cache --progress=plain --iidfile "$TMP/$2.iid" \
        -f "$REPO/tests/fixtures/docker/context-list.Dockerfile" --build-arg "NODE_VERSION=$NODE_VERSION" \
        "$1" >"$log" 2>&1; then
    cat "$log" >&2
    fail "docker build of the $2 context listing failed"
  fi
  grep -q "node:$NODE_VERSION-slim" "$log" || { cat "$log" >&2; fail "the build did not use node:$NODE_VERSION-slim (--build-arg NODE_VERSION had no effect)"; }
  # `RUN find /ctx` prints one path per line, as "#<step> <seconds> /ctx/<path>" in the plain progress output.
  sed -nE 's|^#[0-9]+ [0-9.]+ (/ctx(/.*)?)$|\1|p' "$log"
}

leaked=0
check_context() {   # check_context <dir> <name> <samples...>
  local dir="$1" name="$2" listing s; shift 2
  listing="$(list_context "$dir" "$name")"
  grep -qx "/ctx/marker.txt" <<<"$listing" || fail "the control file marker.txt is not in the $name listing (could not read the context)"
  grep -qx "/ctx/.env.example" <<<"$listing" || fail "the allowlisted .env.example is not in the $name listing"
  for s in "$@"; do
    if grep -qxF "/ctx/$s" <<<"$listing"; then echo "LEAK ($name): $s is in the build context" >&2; leaked=1; fi
  done
}

echo "listing two build contexts with node:$NODE_VERSION-slim (${#root_samples[@]} root and ${#sub_samples[@]} subdirectory samples from $entries entries)"
check_context "$ROOT_CTX" root "${root_samples[@]}"
check_context "$SUB_CTX" subdirectory "${sub_samples[@]}"
(( leaked == 0 )) || fail "files that .gitignore ignores reach the build context; add them to .dockerignore"
echo "gitignore coverage: $(( ${#root_samples[@]} + ${#sub_samples[@]} )) samples from $entries .gitignore entries, none in a build context"
