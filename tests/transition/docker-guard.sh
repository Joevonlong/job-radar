#!/usr/bin/env bash
# The `docker` of the upgrade transition (tests/transition/run.sh puts a wrapper first on PATH that runs this with its
# settings). Every docker command of the scripts under test goes through here:
#   - read-only commands go through: info, version, ps, inspect, logs, image inspect|ls, volume inspect|ls, system df|info
#   - compose: read-only subcommands (config, ps, ls, images, logs, top, version, port) go through; any other needs a
#     project named $TRANSITION_PREFIX… (from -p / --project-name or COMPOSE_PROJECT_NAME) whose ports this run
#     registered ($TRANSITION_ROOT/projects/<project>.ports), and first runs `docker compose <same options> config
#     --format json` with the same environment through compose-check.mjs: the project's volumes, bind mounts, build
#     contexts and published ports must all be this run's (see there). `down` is refused: run.sh removes its projects
#     itself. With $TRANSITION_FAIL_FLAG present, `build` gets --build-arg FAIL_RUNNER_BUILD=1.
#   - everything else is refused (exit 97): prune, rm, volume rm, system prune, run, …
#
#   TRANSITION_REAL_DOCKER  the docker binary
#   TRANSITION_PREFIX       e.g. jrtransition-1a2b3c4d- (must start with jrtransition-)
#   TRANSITION_ROOT         the run's temporary directory (absolute)
#   TRANSITION_FAIL_FLAG    the flag file of the failing build
set -uo pipefail

real="${TRANSITION_REAL_DOCKER:-}" prefix="${TRANSITION_PREFIX:-}" root="${TRANSITION_ROOT:-}" flag="${TRANSITION_FAIL_FLAG:-}"
refuse() { echo "transition docker guard: refused: docker $*" >&2; exit 97; }
[[ -x "$real" && "$prefix" == jrtransition-?*- && "$root" == /* && -d "$root" ]] || { echo "transition docker guard: not configured" >&2; exit 97; }
CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/compose-check.mjs"

case "${1:-}" in
  info|version|ps|inspect|logs) exec "$real" "$@" ;;
  image) [[ "${2:-}" == inspect || "${2:-}" == ls ]] && exec "$real" "$@"; refuse "$@" ;;
  volume) [[ "${2:-}" == inspect || "${2:-}" == ls ]] && exec "$real" "$@"; refuse "$@" ;;
  system) [[ "${2:-}" == df || "${2:-}" == info ]] && exec "$real" "$@"; refuse "$@" ;;
  compose) ;;
  *) refuse "$@" ;;
esac

args=("$@"); global=(); out=(); project="${COMPOSE_PROJECT_NAME:-}"; named=(-p "$project"); sub=""; i=1
while (( i < ${#args[@]} )); do
  a="${args[$i]}"
  if [[ -z "$sub" ]]; then
    case "$a" in
      -p|--project-name) project="${args[$((i + 1))]:-}"; named=(); global+=("$a" "$project"); i=$((i + 2)); continue ;;
      --project-name=*) project="${a#*=}"; named=(); global+=("$a") ;;
      -f|--file|--env-file|--profile|--project-directory|--ansi|--progress|--parallel) global+=("$a" "${args[$((i + 1))]:-}"); i=$((i + 2)); continue ;;
      -*) global+=("$a") ;;
      *) sub="$a"
         if [[ "$sub" == build && -n "$flag" && -e "$flag" ]]; then out+=(--build-arg FAIL_RUNNER_BUILD=1); fi ;;
    esac
    i=$((i + 1)); continue
  fi
  out+=("$a"); i=$((i + 1))
done
[[ -n "$sub" ]] || exec "$real" "$@"   # `docker compose` alone, or --version
case "$sub" in config|ps|ls|images|logs|top|version|port) exec "$real" compose ${global[@]+"${global[@]}"} "$sub" ${out[@]+"${out[@]}"} ;; esac
[[ "$sub" != down ]] || refuse "$@"
[[ "$project" == "$prefix"?* && "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || refuse "$@"
ports="$root/projects/$project.ports"
[[ -f "$ports" ]] || refuse "$@"
# the same options and the same environment as the command itself: what compose would do is what gets checked
"$real" compose ${global[@]+"${global[@]}"} ${named[@]+"${named[@]}"} config --format json 2>/dev/null \
  | node "$CHECK" config "$project" "$prefix" "$root" "$ports" || refuse "$@"
exec "$real" compose ${global[@]+"${global[@]}"} "$sub" ${out[@]+"${out[@]}"}
