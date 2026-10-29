#!/usr/bin/env bash
# Config readers for the ops scripts (backup.sh, restore.sh). Sourced, not run on its own. Bash 3.2 compatible.
#
#   cfg_get <file> <path>...
#       The validated effective values, read by the app's own loader: `node --import <tsx> scripts/config-get.ts`.
#       Prints one line per path (a string as it is, anything else as JSON). Non-zero when node or tsx is missing,
#       the config is invalid or a path is not there; the caller then falls back to cfg_identity or a safe default.
#
#   cfg_identity <file> <path> <validator> [<default>]
#       One simple scalar read by this shell alone (no node), for when cfg_get cannot run. Prints the value and returns:
#         0  a value (the file's, or <default>)
#         2  unclear: the file is not in the subset below, or the value does not pass <validator>; nothing is printed
#         3  missing: the key is not there and there is no <default> (a required key such as `timezone`)
#       Which file it reads, as the loader does:
#         - no user file: the shipped file, then <default>;
#         - a user file in the whole-file format (without config_version, or older than the overlay format of that file;
#           in this version every user file): the user file, then <default>; the shipped file is NOT read;
#         - a user file in the overlay format (`cfg_overlay_format_version`; none yet): `!unset` on the key or on a
#           parent gives <default>; a key the user file does not have is read from the shipped file, then <default>.
#       The YAML subset: block mappings, plain, 'single' and "double" quoted scalars (no escapes), comments. On the path
#       being read, anything else is unclear: flow style ({} []), anchors and aliases, block scalars (| >), tags other
#       than !unset, a parent that is not a mapping, duplicate keys; anywhere in the file: tab indentation, more than one
#       document, a file that cannot be read or is not UTF-8.
#       Validators: compose_project (^[a-z0-9][a-z0-9_-]*$), timezone (see _cfg_valid_timezone), positive_int.
#
# The directories are the checkout's: <app>/data/config (the user's) and <app>/config (the shipped files), as the ops scripts
# have always read them; CFG_USER_DIR / CFG_SHIPPED_DIR override them (tests). cfg_get passes the same two directories to the
# loader (JOB_RADAR_CONFIG_DIR / JOB_RADAR_DEFAULTS_DIR), so both readers look at the same files whatever the shell has set.

_cfg_app="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CFG_USER_DIR="${CFG_USER_DIR:-$_cfg_app/data/config}"
CFG_SHIPPED_DIR="${CFG_SHIPPED_DIR:-$_cfg_app/config}"

# The script defaults of the keys read with a default; tests/ops/config-sh.test.ts checks they equal the zod defaults.
# shellcheck disable=SC2034 # used by the scripts that source this file
CFG_DEFAULT_COMPOSE_PROJECT="job-radar"
CFG_DEFAULT_BACKUP_MAX_AGE_HOURS="30"

# The overlay format version of each file (the config_version from which a user file is an overlay rather than a whole
# file). Empty in this version: every user file is read with whole-file semantics.
cfg_overlay_format_version() {
  case "$1" in
    *) printf '' ;;
  esac
}

cfg_get() {
  local file="$1"
  shift
  local loader="$_cfg_app/node_modules/tsx/dist/loader.mjs"
  command -v node > /dev/null 2>&1 || { echo "config: node is not installed, cannot read the validated config" >&2; return 1; }
  [[ -f "$loader" ]] || { echo "config: $loader is missing (run pnpm install), cannot read the validated config" >&2; return 1; }
  (cd "$_cfg_app" && JOB_RADAR_CONFIG_DIR="$CFG_USER_DIR" JOB_RADAR_DEFAULTS_DIR="$CFG_SHIPPED_DIR" node --import "$loader" "$_cfg_app/scripts/config-get.ts" "$file" "$@")
}

# The awk reader: prints "<KIND>\t<value>\t<line>", KIND = PLAIN | QUOTED | UNSET | MISSING | AMBIGUOUS (value = the reason).
_cfg_scan() {
  LC_ALL=C awk -v want="$2" '
    function indent(s,   i) { i = match(s, /[^ ]/); return i ? i - 1 : length(s) }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function result(kind, a, b) { printf "%s\t%s\t%s\n", kind, a, b; finished = 1; exit }
    function nocomment(s,   p) {
      if (s ~ /^#/) return ""
      if (match(s, /[ \t]#/)) s = substr(s, 1, RSTART - 1)
      return trim(s)
    }
    function content_line(s) { return s !~ /^[ \t]*$/ && s !~ /^[ ]*#/ }
    # the indentation of the next content line after line i (-1 at the end of the file)
    function next_indent(i,   j) {
      for (j = i + 1; j <= n; j++) if (content_line(L[j])) return indent(L[j])
      return -1
    }
    # one quoted scalar at the start of s: sets qval and qrest; returns 0 when it is not in the subset
    function quoted(s,   q, j, c, len) {
      q = substr(s, 1, 1); qval = ""; len = length(s)
      for (j = 2; j <= len; j++) {
        c = substr(s, j, 1)
        if (q == "\"" && c == "\\") return 0
        if (c == q) {
          if (q == "'"'"'" && substr(s, j + 1, 1) == "'"'"'") { qval = qval c; j++; continue }
          qrest = substr(s, j + 1)
          return 1
        }
        qval = qval c
      }
      return 0
    }
    { L[NR] = $0 }
    END {
      if (finished) exit
      n = NR
      for (i = 1; i <= n; i++) {
        sub(/\r$/, "", L[i])
        if (L[i] ~ /^[ \t]*\t[ \t]*[^ \t]/) result("AMBIGUOUS", "tab indentation", i)
        if (L[i] ~ /^(---|\.\.\.)([ \t]|$)/) result("AMBIGUOUS", "more than one document (--- or ...)", i)
        if (L[i] ~ /^%/) result("AMBIGUOUS", "a YAML directive", i)
      }
      nseg = split(want, seg, ".")
      start = 1; parent = -1
      for (d = 1; d <= nseg; d++) {
        level = -1; found = 0; inseq = 0
        for (i = start; i <= n; i++) {
          line = L[i]
          if (!content_line(line)) continue
          ind = indent(line)
          if (ind <= parent) break
          if (level < 0) level = ind
          if (ind > level) continue
          if (ind < level) result("AMBIGUOUS", "inconsistent indentation", i)
          c = substr(line, ind + 1)
          # a list written at the same indentation as its key (`key:` then `- item`) belongs to that key
          if (c ~ /^-([ \t]|$)/) { if (inseq) continue; result("AMBIGUOUS", "a list where a mapping is expected", i) }
          if (c ~ /^\?([ \t]|$)/) result("AMBIGUOUS", "an explicit key (?)", i)
          if (c ~ /^[{[]/) result("AMBIGUOUS", "flow style ({} or [])", i)
          if (c ~ /^[&*]/) result("AMBIGUOUS", "an anchor or alias", i)
          if (c ~ /^[!|>]/) result("AMBIGUOUS", "a tag or block scalar where a key is expected", i)
          if (c ~ /^["'"'"']/) {
            if (!quoted(c)) result("AMBIGUOUS", "a quoted key outside the supported subset", i)
            k = qval; rest = qrest
            if (rest !~ /^:([ \t]|$)/) result("AMBIGUOUS", "not a mapping entry", i)
            rest = substr(rest, 2)
          } else {
            if (!match(c, /:([ \t]|$)/)) result("AMBIGUOUS", "not a mapping entry", i)
            k = trim(substr(c, 1, RSTART - 1)); rest = substr(c, RSTART + 1)
          }
          if (k == "<<") result("AMBIGUOUS", "a merge key (<<)", i)
          inseq = nocomment(trim(rest)) == ""
          if (k == seg[d]) {
            if (found) result("AMBIGUOUS", "duplicate key " k, i)
            found = i; frest = trim(rest); flevel = level
          }
        }
        if (!found) result("MISSING", "", "")
        v = nocomment(frest)
        if (d < nseg) {
          if (v == "!unset") result("UNSET", "", found)
          if (v != "") {
            if (v ~ /^[{[]/) result("AMBIGUOUS", "flow style ({} or [])", found)
            if (v ~ /^[&*]/) result("AMBIGUOUS", "an anchor or alias", found)
            if (v ~ /^!/) result("AMBIGUOUS", "a tag", found)
            result("AMBIGUOUS", "a parent of the key is a scalar, not a mapping", found)
          }
          if (next_indent(found) <= flevel) {
            for (j = found + 1; j <= n && !content_line(L[j]); j++) ;
            if (j <= n && substr(L[j], indent(L[j]) + 1) ~ /^-([ \t]|$)/) result("AMBIGUOUS", "a parent of the key is a list, not a mapping", found)
            result("AMBIGUOUS", "a parent of the key is empty, not a mapping", found)
          }
          start = found + 1; parent = flevel
          continue
        }
        deeper = next_indent(found) > flevel
        first = substr(frest, 1, 1)
        if (first == "\"" || first == "'"'"'") {
          if (!quoted(frest)) result("AMBIGUOUS", "a quoted value outside the supported subset (escapes or several lines)", found)
          after = trim(qrest)
          if (after != "" && after !~ /^#/) result("AMBIGUOUS", "text after a quoted value", found)
          if (deeper) result("AMBIGUOUS", "not a single-line value", found)
          if (qval ~ /\t/) result("AMBIGUOUS", "a tab in the value", found)
          result("QUOTED", qval, found)
        }
        if (v == "!unset") result("UNSET", "", found)
        if (v == "") result("AMBIGUOUS", deeper ? "not a scalar (a mapping or a list)" : "no value", found)
        if (v ~ /^[{[]/) result("AMBIGUOUS", "flow style ({} or [])", found)
        if (v ~ /^[&*]/) result("AMBIGUOUS", "an anchor or alias", found)
        if (v ~ /^[|>]/) result("AMBIGUOUS", "a block scalar (| or >)", found)
        if (v ~ /^!/) result("AMBIGUOUS", "a tag other than !unset", found)
        if (v ~ /^[@`]/ || v ~ /^-([ \t]|$)/ || v ~ /^\?([ \t]|$)/) result("AMBIGUOUS", "not a plain value", found)
        if (v ~ /:([ \t]|$)/) result("AMBIGUOUS", "not a plain value", found)
        if (deeper) result("AMBIGUOUS", "not a single-line value", found)
        if (v ~ /\t/) result("AMBIGUOUS", "a tab in the value", found)
        result("PLAIN", v, found)
      }
    }
  ' "$1"
}

# True when a plain scalar is a string to YAML (not null, a boolean or a number).
_cfg_plain_string() {
  local v="$1"
  case "$v" in
    null|Null|NULL|"~"|true|True|TRUE|false|False|FALSE|.inf|.Inf|.INF|-.inf|+.inf|.nan|.NaN|.NAN) return 1 ;;
  esac
  [[ "$v" =~ ^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$ || "$v" =~ ^0x[0-9a-fA-F]+$ || "$v" =~ ^0o[0-7]+$ ]] && return 1
  return 0
}

# Order matters and the three branches never hand over to each other (Etc/GMT+15 is not a region name).
_cfg_valid_timezone() {
  local v="$1" zi="${JOB_RADAR_ZONEINFO_DIR:-/usr/share/zoneinfo}"
  [[ $v == UTC ]] && return 0
  if [[ $v == Etc/* ]]; then
    [[ $v =~ ^Etc/(UTC|UCT|Universal|Zulu|GMT|GMT0|GMT[+-]0|Greenwich|GMT\+([1-9]|1[0-2])|GMT-([1-9]|1[0-4]))$ ]] || return 2
  else
    [[ $v =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}$ ]] || return 2
  fi
  # with a zoneinfo directory the zone must exist in it
  [[ ! -d $zi ]] || [[ -f $zi/$v ]] || return 2
  return 0
}

# _cfg_valid <validator> <kind> <value>
_cfg_valid() {
  local validator="$1" kind="$2" v="$3"
  case "$validator" in
    compose_project)
      [[ $kind == QUOTED ]] || _cfg_plain_string "$v" || return 2
      [[ $v =~ ^[a-z0-9][a-z0-9_-]*$ ]] || return 2 ;;
    timezone)
      [[ $kind == QUOTED ]] || _cfg_plain_string "$v" || return 2
      _cfg_valid_timezone "$v" || return 2 ;;
    positive_int)
      [[ $kind == PLAIN && $v =~ ^[1-9][0-9]*$ ]] || return 2 ;;
    *) echo "config: unknown validator '$validator'" >&2; return 2 ;;
  esac
  return 0
}

# True when the file is valid UTF-8. macOS iconv fails when its output is /dev/null, so it writes into a pipe. Without
# iconv the check is skipped: every validator accepts ASCII only, so a byte that is not UTF-8 in the value is still rejected.
_cfg_utf8() {
  command -v iconv > /dev/null 2>&1 || return 0
  iconv -f UTF-8 -t UTF-8 < "$1" 2> /dev/null | cat > /dev/null
  [[ ${PIPESTATUS[0]} == 0 ]]
}

# _cfg_read <file path> <key path> -> sets _cfg_kind, _cfg_value, _cfg_line; non-zero when the file cannot be read
_cfg_read() {
  local out
  _cfg_kind=""; _cfg_value=""; _cfg_line=""
  if [[ ! -r "$1" ]] || ! _cfg_utf8 "$1"; then
    _cfg_kind="AMBIGUOUS"; _cfg_value="the file cannot be read or is not UTF-8"
    return 0
  fi
  out="$(_cfg_scan "$1" "$2")" || { _cfg_kind="AMBIGUOUS"; _cfg_value="the file cannot be read"; return 0; }
  IFS=$'\t' read -r _cfg_kind _cfg_value _cfg_line <<< "$out"
  [[ -n "$_cfg_kind" ]] || _cfg_kind="AMBIGUOUS"
  return 0
}

cfg_identity() {
  local file="$1" key="$2" validator="$3" default="${4-}" has_default=0
  [[ $# -ge 4 ]] && has_default=1
  local user="$CFG_USER_DIR/$file" shipped="$CFG_SHIPPED_DIR/$file" overlay_from mode="legacy" source

  _cfg_fallback() {
    if [[ $has_default == 1 ]]; then printf '%s\n' "$default"; return 0; fi
    echo "config: $file: $key is missing (it is required)" >&2
    return 3
  }
  _cfg_unclear() {
    echo "config: $1${_cfg_line:+ line $_cfg_line}: cannot read $key: $2" >&2
    return 2
  }
  _cfg_found() {
    _cfg_valid "$validator" "$_cfg_kind" "$_cfg_value" || { _cfg_unclear "$1" "'$_cfg_value' is not a valid $validator"; return 2; }
    printf '%s\n' "$_cfg_value"
    return 0
  }

  if [[ -e "$user" ]]; then
    overlay_from="$(cfg_overlay_format_version "$file")"
    if [[ -n "$overlay_from" ]]; then
      _cfg_read "$user" config_version
      case "$_cfg_kind" in
        MISSING) ;;
        PLAIN) [[ $_cfg_value =~ ^[1-9][0-9]*$ ]] || { _cfg_unclear "$user" "config_version is not a whole number"; return 2; }
               (( 10#$_cfg_value >= overlay_from )) && mode="overlay" ;;
        *) _cfg_unclear "$user" "config_version: ${_cfg_value:-not a plain number}"; return 2 ;;
      esac
    fi
    _cfg_read "$user" "$key"
    case "$_cfg_kind" in
      PLAIN|QUOTED) _cfg_found "$user"; return $? ;;
      AMBIGUOUS) _cfg_unclear "$user" "$_cfg_value"; return 2 ;;
      UNSET)
        [[ $mode == overlay ]] || { _cfg_unclear "$user" "!unset in a file without the overlay format"; return 2; }
        _cfg_fallback; return $? ;;
      MISSING) [[ $mode == overlay ]] || { _cfg_fallback; return $?; } ;;
    esac
  fi
  source="$shipped"
  [[ -e "$source" ]] || { _cfg_fallback; return $?; }
  _cfg_read "$source" "$key"
  case "$_cfg_kind" in
    PLAIN|QUOTED) _cfg_found "$source"; return $? ;;
    MISSING) _cfg_fallback; return $? ;;
    UNSET) _cfg_unclear "$source" "!unset in a shipped file"; return 2 ;;
    *) _cfg_unclear "$source" "$_cfg_value"; return 2 ;;
  esac
}
