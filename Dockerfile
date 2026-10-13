# syntax=docker/dockerfile:1
#
# Multi-stage build for the Job Radar images (targets: web, runner).
#   docker build --target web    -t job-radar-web .
#   docker build --target runner -t job-radar-runner .

ARG NODE_VERSION=22
# Must equal the @playwright/test version in package.json (tests/dockerfile.test.ts enforces it).
ARG PLAYWRIGHT_VERSION=1.64.0
ARG PNPM_VERSION=11.15.1
# AI CLIs used by the runner's claude-cli / codex-cli providers. Pinned to the versions the recorded
# fixtures in tests/fixtures/ai come from; to upgrade, re-record the fixtures and run `pnpm ai:probe`.
ARG CLAUDE_CODE_VERSION=2.1.288
ARG CODEX_VERSION=0.160.0
# pg_dump for the runner's daily backup. Its major version must be >= the db image's (compose.yaml: postgres:17);
# tests/dockerfile.test.ts keeps the two in step.
ARG POSTGRES_CLIENT_VERSION=17

# ---- base: node + pinned pnpm --------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# pnpm from npm rather than corepack: no network lookups at build time beyond the pinned install.
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# ---- deps: install with the lockfile only (cacheable layer) ---------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ---- build: Next standalone output + bundled runner ---------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm build && pnpm build:runner

# ---- web: Next.js standalone server --------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# compose may run the web under another uid (PUID / PGID on Linux): Next's cache directory must be writable for it too.
RUN mkdir -p .next/cache && chmod 1777 .next/cache
# The shipped defaults (config/) are part of the image: owned by root, readable by any uid, writable by none of them.
# The user's own config stays outside the image (data/config, a bind mount). Next's standalone output already holds a
# traced copy of config/ owned by node (its directories would stay writable for the web): replace it.
ENV JOB_RADAR_DEFAULTS_DIR=/app/config
RUN rm -rf /app/config
COPY config/ /app/config/
RUN chmod -R a+rX,go-w /app/config
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# ---- node22: source of a Node 22 binary for the runner ---------------------------------------
FROM node:${NODE_VERSION}-slim AS node22

# ---- runner: Playwright base image + a single bundled script -----------------------------------
# The Playwright noble image ships Node 24; copy the Node 22 binary over it so the runner
# runs the same major version as dev and CI (Node 22).
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runner
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
# The subscription CLIs. Installed as root before dropping to pwuser; they run under the Node 22
# binary above (their shebang is `env node`). Auth is supplied at run time (see compose.yaml): never baked in.
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
# pg_dump / pg_restore of the same major as the database. Ubuntu noble ships 16, so the client comes from the
# PostgreSQL project's apt repository (apt.postgresql.org).
ARG POSTGRES_CLIENT_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-${POSTGRES_CLIENT_VERSION} \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
# esbuild bundles src/runner and its dependencies into one file (no node_modules needed at runtime), except playwright-core
# (`build:runner` marks it external: it loads browser drivers dynamically). The linkedin-session channel needs it at
# runtime, at the same version as the base image's browsers. The browsers themselves come with the base image.
ARG PLAYWRIGHT_VERSION
RUN npm install --prefix /app --no-save --no-package-lock --no-audit --no-fund playwright-core@${PLAYWRIGHT_VERSION} \
    && npm cache clean --force
COPY --from=build --chown=pwuser:pwuser /app/dist/runner.mjs ./dist/runner.mjs
# Mount points the compose file binds over (data/backups: the daily pg_dump, see RUNNER_BACKUP_DIR; data/exports: JD exports for resume-kit).
RUN mkdir -p /app/data/backups /app/data/profile /app/data/exports /app/data/config && chown -R pwuser:pwuser /app/data
# The container healthcheck (compose.yaml): reads the newest heartbeat and exits 1 when it is too old.
COPY --from=build --chown=pwuser:pwuser /app/dist/healthcheck.mjs ./dist/healthcheck.mjs
COPY --from=build --chown=pwuser:pwuser /app/drizzle ./drizzle
# The shipped defaults, as in the web image.
ENV JOB_RADAR_DEFAULTS_DIR=/app/config
COPY config/ /app/config/
RUN chmod -R a+rX,go-w /app/config
# Test hook only: a non-empty value makes the runner build fail (upgrade tests use it to simulate a failed build).
ARG FAIL_RUNNER_BUILD=""
RUN if [ -n "$FAIL_RUNNER_BUILD" ]; then echo "FAIL_RUNNER_BUILD is set: failing the runner build on purpose" >&2; false; fi
USER pwuser
CMD ["node", "dist/runner.mjs"]
