# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report privately with GitHub's **Private vulnerability reporting**: open the
repository's **Security** tab and choose "Report a vulnerability". GitHub keeps the report visible only to you and the
maintainers. Include what you found, how to reproduce it and what you think the impact is. You can expect an
acknowledgement within a week. If the button is missing, open a public issue that says only "I have a security report,
please enable private reporting" and put no details in it.

## Scope and design notes

Job Radar is a single-user tool that you run on your own machine:

- The web interface binds to `127.0.0.1` only and, by default, has no login. An optional password
  (`JOB_RADAR_WEB_PASSWORD_HASH`, made with `pnpm web:password`; `docs/configuration.md`, "Web access") puts a sign-in
  page in front of every page, API route and Server Action; set it before anybody else can reach the web (a shared
  tailnet, the LAN through `JOB_RADAR_WEB_BIND`, a reverse proxy). The password is stored as an scrypt hash, compared
  in constant time and never logged; sessions are HMAC-signed `HttpOnly`, `SameSite=Lax` cookies (`Secure` and the
  `__Host-` prefix over https) that end when the password changes or on "Sign out everywhere"; failed logins are rate-limited per source and globally before any hash is
  computed. Do not publish port 3000 to a network you do not trust without it; for phone access use a private overlay
  network such as Tailscale, not a public tunnel.
- With a password set, requests from the machine itself skip the login: the decision rests on request headers (the
  `Host`, the forwarded client address, the absence of proxy headers), because the web cannot see the real peer address
  inside Docker, and a client can send any of these headers itself. The exemption is therefore on only when
  `JOB_RADAR_WEB_BIND` says the web is reachable on loopback only: compose always sets it (default `127.0.0.1`, where the
  port is published), and `pnpm start` / `pnpm dev` make Next listen on it. Without it (a hand-run `next start`, the image
  run without compose) and with any non-loopback address, every request needs the password. Residual risk: another
  container on the same compose network, a TCP forward on the machine (`tailscale serve --tcp`, `socat`, `ssh -R`), or a
  reverse proxy on the same machine configured to send `Host: 127.0.0.1` without forwarding headers, passes as local.
  Set `JOB_RADAR_WEB_LOCAL_LOGIN=1` to require the password for every request; it is recommended whenever the web is
  reachable from elsewhere by any route other than `tailscale serve` (https).
  - Private forwarded addresses (the Docker gateway) count as local only when `JOB_RADAR_WEB_BIND` is set.
    `JOB_RADAR_WEB_BIND` must name the address the web is actually published on: published some other way, the
    exemption stays on (the doctor fails `compose.web`). Running `next start` directly with `JOB_RADAR_WEB_BIND=127.0.0.1`
    in `.env` but listening on every interface is the same mistake: use `pnpm start`.
  - Edge case: `tailscale serve --http` (plain http) together with a subnet router. A device on the routed LAN has no
    tailnet identity, so no `Tailscale-User-*` header is added, and its forwarded address is a private one; sending
    `Host: localhost` itself, it passes as local. The default `tailscale serve` (https) is not affected
    (`X-Forwarded-Proto: https` is never local). If you use `--http` and a subnet router, set
    `JOB_RADAR_WEB_LOCAL_LOGIN=1`.
- Login limits: the per-source limit keys on the address the nearest hop saw (the last `X-Forwarded-For` entry:
  `tailscale serve` sets it to the tailnet address). Besides it, after `ui.yaml: web_access.global_max_failures` failed
  logins from all sources together within `login_window_minutes`, **every** login has to wait after each further failure,
  `global_delay_seconds` at first and twice as long each time, at most `login_lockout_minutes`. Trade-off: this stops a
  password guesser who rotates source addresses, at the price that such a guesser can slow down your sign-in from a new
  device. A browser that still holds a valid session is not held up, sessions already open stay valid, and the machine
  itself keeps its local exemption (unless `JOB_RADAR_WEB_LOCAL_LOGIN=1`), so you are never locked out of the host. The
  web log records every lockout and the start of each wait (never the address). A restart of the web clears the counters.
- Ending every session: "Sign out everywhere" on the settings page (it raises the session generation in
  `data/config/.web-session-generation`); or change the password (`pnpm web:password`); or replace the signing key:
  delete `data/config/.web-session-secret` (a new one is created on the next request), or set a new
  `JOB_RADAR_SESSION_SECRET` when you use one, then `docker compose up -d web` (the web caches the key).
- Secrets (API keys, the Telegram bot token, the Gmail app password, login states) live only in `.env` and `.auth/`,
  both ignored by git, and must never appear in logs or error messages. A leak of either in the code or in a log is a
  vulnerability: please report it.
- Your profile and applications stay in the local database and `data/`. The AI provider you configure receives your profile
  summary, skills and languages, your search preferences (target titles and cities, salary floor, contract preferences,
  excluded companies and keywords, your own scoring criteria) and the job descriptions; the weekly suggestion also
  receives the jobs you marked, with their status. Job summaries go to your own Telegram chat. The exact list is in
  [docs/privacy.md](docs/privacy.md).
- The Telegram bot accepts commands and button presses only from the one configured chat id.
- Reaching the web is equivalent to acting as you on the host: the settings it saves are read by the runner and by the
  host ai-worker, which runs the AI command-line tools under your user account with every secret of `.env`. Two
  defences keep a web page from abusing that:
  - **Host allowlist**: the web answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]`, `*.ts.net` and the
    names in `JOB_RADAR_ALLOWED_HOSTS` (an environment variable, never a web-editable file); a foreign `Host`,
    `X-Forwarded-Host` or `Origin` gets `421`. This blocks DNS rebinding, where another site re-points its name at
    `127.0.0.1` so that your own browser talks to the dashboard on its behalf. A state-changing request must also come
    from the same host it is sent to, so another allowed host (another tailnet machine, another local port) cannot
    submit forms or Server Actions.
  - **Protected config keys**: commands, API hosts, Codex overrides, scraping proxies, the resume-kit paths and credential paths cannot be changed through the
    web (forms, advanced editor, wizard), only by editing the file, unless `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` is set.
    The list is in `docs/configuration.md`.
  - **Checks where the values are used**: whatever the file says (edited by hand, or with the opt-in above), the
    ai-worker and the runner start only the `claude` / `codex` executables, keep the Codex tools off, pass only allowed
    Codex overrides, and send API keys, the Telegram token and the Gmail login only to the vendors' own hosts (never
    following a redirect) unless `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` is set. Only one ai-worker runs per database.
  - Responses forbid framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), content sniffing and cross-site
    referrers, and carry no `X-Powered-By` header.
- Links that come from data (the link check of postings, the recheck of watched jobs) are fetched only from public
  addresses: the name is checked before the request and resolved again where the connection is made, and the connection
  goes to exactly the addresses that passed, so a short-lived DNS answer cannot point it at the Docker network or this
  machine. Each fetch has a time limit (`pipeline.yaml: lifecycle.link_check_timeout_ms`).
- Config and profile files the first run seeds from the examples are created owner-only (`0600`) from the start.
- Containers: web, runner and jobspy drop every Linux capability and run with `no-new-privileges`; web and jobspy have a
  read-only root file system (tmpfs for `/tmp` and the Next cache); runner and jobspy have memory caps
  (`RUNNER_MEM_LIMIT`, `JOBSPY_MEM_LIMIT`). The database keeps the capabilities its entrypoint needs.
- **AI calls run without tools, with one exception.** Every AI call (scoring, signals, translation, summaries,
  suggestions, breakdown, trap checks) runs with no tools at all: no shell, no files, no web. The single exception is the
  salary lookup, a button on the job page that is off until you turn it on in `salary.yaml`: it may search the public
  web. The task list is fixed in the code, not in any setting. Be aware of what the limits are and are not:
  - only the company name, job title, city, country and seniority go into the request, never your profile or the JD;
    but the pages the AI reads are untrusted text, and its answer is checked (sources, plausible figures) before it is
    stored and shown;
  - with `claude-cli`, page fetches are pre-approved only for the hosts in `lookup.allowed_fetch_domains` and every
    other tool call is denied (`--permission-mode dontAsk`; `--setting-sources project` keeps the permission rules of
    your own `~/.claude/settings.json` out). This is the CLI's own permission check, not a network boundary, and its
    web search is not limited to those domains;
  - with the Anthropic API, search results are limited to those domains by the API (an empty list means no search);
  - public suffixes such as `co.uk` or `github.io` are refused in that list;
  - with `codex-cli` (only if you add it to the task), web search has no domain limit at all.
- `tailscale serve` gives every device of your tailnet the same access as the Mac itself; restrict it with Tailscale ACLs
  if other people or untrusted devices share the tailnet.

Examples of reports we want: injection or path traversal in the web interface or scripts, a way to read `.env`
or `data/` through the web server, a way past the login when a password is set (other than the documented local exemption), an unauthenticated action
that changes data when the port is exposed beyond loopback,
a secret written to a log, a dependency with an exploitable vulnerability that Job Radar actually uses.

## Verifying a release

Release tags `vX.Y.Z` are signed with the maintainer's SSH key. The public key is in
[`docs/signing-key.pub`](docs/signing-key.pub) (an `allowed_signers` file); its fingerprint is

```
SHA256:HHRRfExpbUjcK0/pdc5E1qf94ogkREVkt9+1VP58JQc
```

Check a tag with `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=docs/signing-key.pub tag -v vX.Y.Z`, or let
`scripts/ops/deploy.sh --ref vX.Y.Z --verify` do it. A tag without a good signature from this key is not a release.
