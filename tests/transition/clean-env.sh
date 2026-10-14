# shellcheck shell=bash
# Sourced by tests/transition/run.sh (and by its test): transition_clean_env < <compose files>
# Unsets every exported variable that could steer docker, compose, the compose files or the database clients of the
# upgrade transition toward something that is not this run's: COMPOSE_* (COMPOSE_FILE, COMPOSE_PROJECT_NAME,
# COMPOSE_PROFILES, ...), DOCKER_HOST / DOCKER_CONTEXT / DOCKER_TLS* / DOCKER_CERT_PATH / DOCKER_DEFAULT_PLATFORM,
# BUILDKIT_* / BUILDX_*, JOBRADAR_* / JOB_RADAR_*, POSTGRES_*, PG*, RUNNER_*, DATABASE_URL, NODE_OPTIONS, and every name
# the compose files on stdin interpolate (${NAME...}). A compose variable of the shell beats the project's .env, so an
# exported JOBRADAR_PG_VOLUME would otherwise point a test project at another installation's database volume.
# Names it unsets that were set are printed to stderr.
transition_clean_env() {
  local names name
  names="$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' | cut -c3- | sort -u)" || true
  names+=$'\n'"DB_HOST_PORT PUID PGID LOG_MAX_SIZE LOG_MAX_FILE JOBSPY_MEM_LIMIT RUNNER_MEM_LIMIT"
  names+=$'\n'"$(compgen -e | grep -E '^(COMPOSE_|JOBRADAR_|JOB_RADAR_|BUILDKIT_|BUILDX_|POSTGRES_|RUNNER_|PG[A-Z]+$|DOCKER_TLS|DOCKER_(HOST|CONTEXT|CERT_PATH|DEFAULT_PLATFORM)$|DATABASE_URL$|NODE_OPTIONS$)' || true)"
  for name in $names; do
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -n "${!name+set}" ]]; then echo "transition: ignoring $name from the environment" >&2; fi
    unset "$name"
  done
}
