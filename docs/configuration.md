# Where the configuration lives: shipped defaults + user config directory

All Job Radar settings are YAML, in two layers:

| Layer | Location (environment variable, default) | Who edits it | In git |
|---|---|---|---|
| Shipped defaults | `JOB_RADAR_DEFAULTS_DIR`, default `config/` | Changes only with product versions | Yes (ships with the product) |
| User config | `JOB_RADAR_CONFIG_DIR`, default `data/config/` | You, the web app (/settings, /interests, /sources/registry), `pnpm config:*` | No (`data/` is ignored) |
| Profile | `JOB_RADAR_PROFILE_DIR`, default `data/profile/` | You, the web app /me | No |

Relative paths are resolved against the project directory (not the current directory). In Docker, the shipped defaults are part of the web and runner images: the Dockerfile copies `config/` to `/app/config` (owned by root, readable by everyone, writable by no one) and sets `JOB_RADAR_DEFAULTS_DIR=/app/config`; nothing is mounted there. `scripts/ops/deploy.sh` builds the images from a `git archive` of the commit it deploys, so the defaults in the containers are exactly the committed `config/`, and a change to `config/` reaches them only with a deploy (a plain `git pull` changes nothing in the running containers). The user config and the profile are bind mounts (`compose.yaml`: web `./data/config:/app/data/config`, runner the same read-only). The host ai-worker reads `config/` from the checkout; `scripts/ops/install-ai-worker.sh` writes all three directories explicitly into its launchd plist or systemd unit.

A file in `data/config/` wins over the default with the same name, so `git pull` never touches your settings, and almost
everything can also be changed on the Settings page. `pnpm config:example` applies a ready-made setup as a head start.

Secrets (API keys, the Telegram token, the Gmail app password, the web password hash) go only in `.env`, never in the
YAML files. The one exception to watch: `jobspy.proxies` in `sources.yaml` can contain proxy credentials
(`user:password@host`), and every backup's config archive includes that file, so keep backup archives private. Which
source needs which key: [installation.md](installation.md#2-optional-create-env).

## Which copy is read

- If the user directory **has** the file, it is read; if not, the one in the defaults directory is read. The layers are not merged: a file in the user directory takes effect as a whole.
- Saving in the web app always writes to the user directory; the first time a file that only exists in the defaults directory is saved, it is generated from the default file as a base (the default file's comments are carried over). The defaults directory is never written. A save also leaves out keys the file does not have yet when the value is just what the schema defaults to (it would pin a default that a later product update may change); keys the file already has are kept, and a value that differs from the default is written.
- Hot reload watches both layers: a user file appearing, being deleted (falling back to the default), or a default file changing (when you have no copy of your own) all take effect within about 5 seconds. In the containers the defaults are in the image and only change with a new image (a deploy); outside Docker (`pnpm dev`, the host ai-worker) a changed file in `config/` is picked up like this. The runner and the ai-worker watch every config file, `me.yaml` and `preferences.yaml` included, and also re-read them at the start of each cycle and each request, so a change (for example the market saved in the setup wizard or on `/me`) applies to the next cycle even when it starts right away, without a restart.
- The web app and the MCP server have no watcher, so they check the files themselves: a read of a config more than 5 seconds after the last check first re-reads every config it has loaded, so a file you edit by hand (or that another process changed) shows up on the next page load without a restart. An invalid file is ignored (the last valid values stay) and reported once in the log. `JOB_RADAR_CONFIG_POLL_MS` (default `5000`, in milliseconds; set it in the environment of the process) is this interval and also the watchers' polling interval; `0` turns off this check and the watchers' polling (a watcher still reacts to file events).
- `pnpm config:check` prints which layer each file is read from: `(user)`, `(default)`, `(user override of a shipped file)`.

## Two kinds of files

| Kind | Files | First-time setup | On product upgrade |
|---|---|---|---|
| `user` | schedule, search, sources, ai, notify, interests, ui, breakdown, resume, insights, language, setup, salary ([salary.md](salary.md)), mcp ([mcp.md](mcp.md)) | Copied from the defaults directory to the user directory, yours from then on | Your files are never changed automatically; format changes are carried over by migrations (`config_version`) |
| `shipped` | models (model catalog and prices), pipeline (parsing rules, city and skill tables), signal-presets (the presets of the "Add category" dialog on `/interests`, see [signals.md](signals.md#add-your-own-interest-point)) | Not copied; always read from the defaults directory | Follows product updates |

A `user` file that a product upgrade introduces is copied from the defaults on the next start; when the user directory
already held configuration (an existing install), a file can be written with the behaviour the install had so far
instead (`language.yaml`: Chinese, see [languages.md](languages.md)). The setup wizard uses the same "existing
install" check.

To change a `shipped` file, copy it into the user directory and edit it there (the whole file overrides). The cost is that later product updates to that file no longer take effect: `pnpm config:check` and the doctor's `config.layers` will keep saying "you override models.yaml". To follow the product again, delete your copy in the user directory.

Market packs (`config/packs/<id>/`: countries, cities, local-language rules) are `shipped` the same way: a copy in `data/config/packs/<id>/` replaces the shipped pack as a whole. See [market-packs.md](market-packs.md).

The profile files `me.yaml` and `preferences.yaml` live in `data/profile/` and are edited on `/me`. The optional
`deal_breakers` list of `preferences.yaml` (rules that veto a job before any AI call) is described in
[deal-breakers.md](deal-breakers.md); its limits are in `pipeline.yaml: filter.deal_breakers`.
Runtime profile readers can use `config/profile.example/` without creating a file. Raw-file checks, the doctor and
watcher still distinguish a missing user profile from a saved one; templates do not become a default config layer.

## Commands

Run these in the project directory.

```bash
pnpm config:init                  # create the user directory, copy missing user files and profile templates; existing ones are untouched (safe to repeat)
pnpm config:init --from <dir>     # copy from another directory (for migrating an old install), and also copy shipped files that differ from the defaults
pnpm config:migrate               # list the files to migrate and their diffs, write nothing
pnpm config:migrate --write       # migrate: first back up the original files to data/config/.backup/<timestamp>/, then write
pnpm config:check                 # validate both layers (default-directory files must be valid even when overridden), print which layer each file is read from and the shipped config identity
pnpm config:example               # list the example setups; `pnpm config:example <id> [--dry-run]` applies one (see below)
```

The web and runner fill missing files at startup, skipping fills during an upgrade freeze. For existing installs,
step 4 of `scripts/ops/deploy.sh` previews migrations, runs `config:check` in memory and checks compose config before
freezing writes. Step 11,
`config-write`, fills and migrates user files only after checking the worker holder and host processes. A first install
runs `config:init` at step 4 without a freeze. Targets without the freeze capability use their older step-4 write flow
(see [downgrades](upgrade.md#downgrade-pre-config-freeze)).
Only freeze-aware web versions refuse saves from step 4. On the first deployment of this version, the older web keeps
running until step 8; any saves it makes still use the old format and are harmless. Install-specific defaults, such as
the language of an existing install, are selected at read time while their files await `config-write`.

### Salary (`salary.yaml`)

The salary benchmark uses only salaries stated in postings; AI lookups are only displayed. The `salary.yaml`
configuration migration from `config_version: 1` to `2` removes `benchmark.include_ai_lookups` and its comment.
`scripts/ops/deploy.sh` previews it in step 4 and writes it in step 11 (`config-write`). For a manual upgrade, stop old
consumers and run `pnpm config:migrate` first to
see what the step removes, then `pnpm config:migrate --write` to save it (originals go to `data/config/.backup/`).
Older files are migrated in memory when loaded; adding this key to a v2 file fails validation as an unknown key.
See [salary.md](salary.md) for the cards and [the changelog](../CHANGELOG.md) for upgrade and rollback notes.

### LinkedIn Monid (`sources.yaml`)

The default cascade is Bright Data → Apify → Monid → session → guest. Monid needs `MONID_API_KEY` in `.env`;
its provider, endpoint and API host are protected keys. The sources migration **3 → 4** adds its block with
`monthly_budget_usd = min(5, global cap)` and inserts it only into the exact previous default cascade.
Custom orders stay unchanged. Before rolling back to code that supports only version 3, restore `sources.yaml`
from `data/config/.backup/`, or remove the Monid block and cascade entry and set `config_version: 3`.
See [Monid](monid.md) for wallet setup, accounting, smoke and stops.

### setup.yaml

`setup.yaml` holds the state of the first-run setup (`completed_at`, `completed_by`, `steps`); the setup wizard and
`pnpm run setup` write it. On a fresh install it starts pending (every page opens `/setup`, the runner holds back its
scheduled cycles). When `config:init` (or the web / runner start-up) finds a user directory that already holds config files
but no `setup.yaml`, it writes one marked complete (`completed_by: existing_install`), so an existing install never sees
the wizard. An unreadable file counts as complete. See [setup.md](setup.md).

## Example setups

The shipped defaults are deliberately neutral: one placeholder keyword group (`targets: [Software Engineer]`), no
company career boards (`ats_boards: []`), no extra title words for the board channels (`include_terms: []`), time zone
`America/New_York` and a US example market in the profile templates. The setup wizard (or `pnpm run setup`) replaces
them with your answers.

Ready-made setups ship as examples in `config/examples/<id>/`. Each holds an `example.yaml` (name, description) and
partial copies of `user` files with only the keys it sets. They are never read unless you apply one:

```bash
pnpm config:example                                  # list them
pnpm config:example ai-engineering-europe --dry-run  # show which settings would change
pnpm config:example ai-engineering-europe            # apply: back up the files that change to data/config/.backup/<timestamp>/, then write
```

Applying merges each file into your copy in `data/config/` (comments kept): maps key by key, lists replaced, except
`ats_boards`, where the boards you do not have yet are added; `keyword_groups` is replaced only while it is still the
shipped placeholder, otherwise the example's groups are added next to yours. A list that replaces entries you have is named in a warning (also with --dry-run). Applying twice changes nothing.

| Example | What it sets |
|---|---|
| `ai-engineering-europe` | `search.yaml` keyword groups for AI / LLM / ML engineering, forward deployed and AI solutions roles; `sources.yaml` AI title words for the job board and company board channels and ten example company career boards (Greenhouse, Lever, Ashby, Personio, SmartRecruiters); `ai.yaml` translation glossary for those job titles. Market, cities and time zone are not part of it: pick them in the wizard (the example was made for the Germany pack, Berlin, `Europe/Berlin`). |

To share your own setup the same way, put a directory with an `example.yaml` and the partial files next to it.

## Protected keys (edited by hand only)

Some values decide which program the host runs or where a credential is sent. The runner and the host ai-worker run with
every secret of `.env`, so the web app (settings forms, advanced editor, setup wizard, source registry) may not change
these keys; you edit them by hand in the file in your config directory:

| File | Protected keys |
|---|---|
| `ai.yaml` | `providers.*.command` (the `claude` / `codex` executables), `providers.*.base_url` (DeepSeek, MiMo), `providers.codex_cli.config_overrides`, `providers.codex_cli.disable_features`, `providers.codex_cli.trim_context` |
| `notify.yaml` | `telegram.api_base_url` |
| `sources.yaml` | every `base_url`, `api_base_url` and `eu_api_base_url`, `jobspy.url`, `jobspy.proxies`, `sources.gmail.host` / `port` / `secure`, `linkedin.session.site.auth_file`, `linkedin.apify.actor_id`, `linkedin.monid.provider`, `linkedin.monid.endpoint` |
| `resume.yaml` | `claude_command`, `claude_args`, `resume_kit_path`, `master_resume_path`, `pdf_dir`, `jd_export_dir`, `jd_export_host_dir` |
| `ui.yaml` | everything under `web_access` (the login limits, see [Web access](#web-access-optional-password-bind-address-and-port)) |

- A save from the web is refused when the value of a protected key differs from the one in the file **and** from the
  shipped default. Writing back the value the file already has, or the shipped default (for example "Restore default",
  or a key that an older file did not have yet), is allowed.
- The settings forms show these fields read-only with a lock note; the advanced editor lists them above the text and marks
  a changed one as a problem on its line ("locked key"), so Save stays off.
- To allow the web to change them anyway (for example on a machine where only you can reach the web), set
  `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` in `.env` and restart the web (`docker compose up -d web`). The forms still show
  the fields locked; use the advanced editor.
- The list lives in `src/lib/config/protected-keys.ts`.

### Checked again where they are used

The lock above is the web side. The ai-worker and the runner do not trust the file either (it may have been edited by
hand, or with `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1`), so a few values are checked again where they are used, whatever the
file says (shipped values always pass):

- `ai.yaml providers.claude_cli.command` / `providers.codex_cli.command` must name the `claude` / `codex` executable (bare
  name or absolute path); `providers.codex_cli.config_overrides` keeps only the context switches set to `false`; the codex
  tool restrictions are always applied, whatever `disable_features` and `trim_context` say.
- `base_url` / `api_base_url` of the services that receive a credential (DeepSeek, MiMo, Telegram, JSearch, Tavily, Brave,
  Apify, Monid) must point to the vendor's own host, and `sources.gmail` to `imap.gmail.com:993` with TLS, unless
  `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` is set in `.env`. Credentialed requests never follow a redirect.
- The claude / codex model names must be plain names (no spaces, not starting with `-`).

The two opt-outs are separate: `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` only lets the web write the keys,
`JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` lets the processes send credentials to a host of your own. What happens when a check
fails is in [ai-providers.md](ai-providers.md#what-the-ai-worker-does-not-take-from-aiyaml); the doctor's `config.guards`
lists every value that is ignored or refused.

## Which host names reach the web (`JOB_RADAR_ALLOWED_HOSTS`)

The web answers only requests addressed to a known host name. This stops DNS rebinding: a web page of another site that
re-points its own name at `127.0.0.1` would otherwise talk to the dashboard as if it were the dashboard itself. Allowed
without any setting:

- `localhost`, `127.0.0.1`, `[::1]` (any port);
- `*.ts.net` (Tailscale: `tailscale serve`, MagicDNS).

The list never comes from a config file the web can write: `notify.yaml: public_base_url` (the link in Telegram messages)
does not add its host. A request whose `Host`, `X-Forwarded-Host` or `Origin` names anything else gets
`421 Misdirected Request` with a short explanation. A request that changes something (a form, a Server Action, anything
but GET / HEAD) must also come from the very address it is sent to: a page on another allowed host, such as another
machine of your tailnet or another program on `localhost:5173`, is a different site and is refused too. Only origins
listed in `JOB_RADAR_ALLOWED_HOSTS` are accepted besides the request's own host. If you reach the web under another name (a reverse proxy such as Caddy or nginx, a LAN name, a LAN IP), add
it to `.env` and restart the web:

```bash
JOB_RADAR_ALLOWED_HOSTS=jobs.example.com,*.home.example,192.168.1.20
```

Entries are comma-separated host names or IP addresses (IPv6 in brackets); `*.example.com` allows every name below
`example.com` (the part after `*.` needs at least two labels, so `*.com` is ignored); `name:port` allows only that port.

A reverse proxy **must** forward the public host name, as `Host` or as `X-Forwarded-Host` (Caddy does by default; with
nginx use `proxy_set_header Host $host;` or `proxy_set_header X-Forwarded-Host $host;`). Otherwise forms and actions are
refused, because the browser's origin does not match the address the web sees. For the Docker image, the Server Actions
origin list is fixed when the image is built; forwarding the host makes it unnecessary.

## Web access: optional password, bind address and port

By default the web listens on `127.0.0.1:3000` only and has no login: on your own machine nobody else can reach it, and
your phone comes in through `tailscale serve`. A password is optional. Set one when anybody but you can reach the
dashboard: through `tailscale serve` on a tailnet you share, on the LAN, or behind a reverse proxy.

```bash
pnpm web:password            # asks twice (no echo), prints one line
# JOB_RADAR_WEB_PASSWORD_HASH=scrypt:131072:8:1:...   -> paste it into .env
docker compose up -d web     # the web reads .env when the container is created
```

The variables (all in `.env`, never in a file the web can write):

| Variable | Default | Meaning |
|---|---|---|
| `JOB_RADAR_WEB_PASSWORD_HASH` | empty | The password as an scrypt hash from `pnpm web:password` (recommended). Empty = no login. |
| `JOB_RADAR_WEB_PASSWORD` | empty | The simple form: the password in plain text. When both are set the hash wins. The doctor suggests the hash. |
| `JOB_RADAR_WEB_BIND` | `127.0.0.1` (compose) | The host address compose publishes the web on, and the address `pnpm start` / `pnpm dev` listen on. `0.0.0.0` (or a LAN address) opens it to the network: set a password first; the doctor fails `compose.web` otherwise. Outside compose, unset means every interface (and no local exemption, see below). |
| `JOB_RADAR_WEB_PORT` | `3000` | The host port of the web (a second instance needs its own, see [multiple-instances.md](multiple-instances.md)). The doctor follows both. |
| `JOB_RADAR_SESSION_SECRET` | generated | The key that signs the session cookies. Unset: 32 random bytes are written to `data/config/.web-session-secret` (mode 0600) on first use. Set it (at least 32 characters) only to share sessions between machines. |
| `JOB_RADAR_WEB_LOCAL_LOGIN` | empty | `1`: requests from this machine need the password too (see below). Recommended whenever the web is reachable from elsewhere. |

How it behaves with a password:

- A visitor without a session who opens a page goes to `/login` and comes back to the page after signing in. Everything
  else (API calls, forms, background requests) answers `401` until then. `/api/health` stays open for health checks.
- A session lasts `ui.yaml: web_access.session_days` (30 days); the cookie is `HttpOnly` and `SameSite=Lax`. Over https
  (`tailscale serve` is https) it is called `__Host-jr_session` and is `Secure` (the browser then only sends it to this
  exact host, over https); over plain http it is `jr_session`. Sessions made over https before this cookie name existed
  are not carried over: after that upgrade you sign in once more on each device that comes in through https. The sign-out button is at the bottom of the sidebar (in the
  menu on a phone).
- Ending every session (a lost phone, a shared browser): **Settings → Signed-in browsers → Sign out everywhere** signs out every
  browser at once, this one too. It raises a counter in `data/config/.web-session-generation`; every session issued
  before is refused from then on, nothing else changes. Changing the password ends every session as well; so does deleting
  `data/config/.web-session-secret` (or changing `JOB_RADAR_SESSION_SECRET`) followed by `docker compose up -d web`.
- Failed logins are limited before the password is even checked: `web_access.login_max_failures` (5) within
  `login_window_minutes` (15) lock that source for `login_lockout_minutes` (15). The source is the last `X-Forwarded-For`
  address, the one the nearest hop saw (`tailscale serve` sets it to the device's tailnet address). Once
  `global_max_failures` (30) failures from all sources together fall within the window, every login has to wait after each
  further failure: `global_delay_seconds` (2) at first, twice as long each time, at most `login_lockout_minutes`. A browser
  that still has a valid session is not held up by that wait. At most `max_concurrent_logins` (4) checks run at once (each
  takes about 128 MB of memory for a moment). The web log records each lockout and the start of each wait, never the
  password or the address.
  `min_password_length` (10) is the shortest password `pnpm web:password` accepts. These keys are protected: change them
  by hand in `data/config/ui.yaml`.
- Signing in over plain http from another machine shows a warning on the login page: the password then crosses the
  network unencrypted. Use `tailscale serve` (https) or an https reverse proxy.
- A hash that cannot be read (copied incompletely, an old format) does **not** turn the login off: nobody can sign in, the
  login page says signing in does not work right now, and the doctor's `web.access` check fails. Run `pnpm web:password` again.

**From this machine without the password.** A request that names this machine (`Host` and `X-Forwarded-Host` are
`localhost`, `127.0.0.1` or `[::1]`), whose forwarded client address is loopback (in compose also a private address: the
Docker gateway), that did not come over https through a proxy and that carries none of the headers only a proxy adds,
skips the login, so the browser on the machine itself needs no password. A client can send all of these headers itself,
so the exemption is only on while `JOB_RADAR_WEB_BIND` is set to a loopback address, that is, while nothing but this
machine can connect:

- compose always sets it (`127.0.0.1` unless you change it) and publishes the port there;
- `pnpm start` and `pnpm dev` make the server listen on `JOB_RADAR_WEB_BIND` (or on `-H <address>` when you pass one).
  Without either they listen on every interface, and then **every** request needs the password, `http://localhost:3000`
  too. Set `JOB_RADAR_WEB_BIND=127.0.0.1` in `.env` to keep the exemption; `pnpm run doctor` warns (`web.access`) when a
  password is set, the web does not run in compose and the variable is unset;
- running `next start` directly is not supported here: it ignores `JOB_RADAR_WEB_BIND` and listens on every interface,
  so with `JOB_RADAR_WEB_BIND=127.0.0.1` in `.env` anyone on the network could claim to be `localhost`. Use `pnpm start`.
  It starts Next through `tsx`, a development dependency: run it in a checkout installed with plain `pnpm install`, not
  `pnpm install --prod`.

Any address that is not loopback switches the exemption off.

**The rule: `JOB_RADAR_WEB_BIND` must name the address the web is published on.** It is how the web learns it is
reachable from the network. Publishing it some other way (editing `ports:` in `compose.yaml`, a compose override, a port
forward) while the variable stays unset or `127.0.0.1` leaves the local exemption on; the doctor's `compose.web` check
fails with "local login exemption is still on". Set `JOB_RADAR_WEB_BIND` to the published address (and a password).

Residual risk: anything on this machine that passes connections on to the web looks local to it. That covers other
containers on the same compose network, a plain TCP forward (`tailscale serve --tcp`, `socat`, `ssh -R`, a router or VPN
port forward to this machine), and a reverse proxy on this machine that you configured to send `Host: 127.0.0.1` without
forwarding headers. `tailscale serve` in its normal https mode is safe: it adds the forwarding headers, so its visitors
always need the password. **When the web is reachable from anywhere but this machine, set `JOB_RADAR_WEB_LOCAL_LOGIN=1`**:
then every request needs the password, and you sign in once on the host as well.

Without a password, a red banner on every page says so whenever the dashboard is reached from another machine (or listens
beyond loopback), and the doctor's `web.access` check warns.

## Who may read the files

The web and the runner write config files with mode `0600` (owner only): `data/config/*.yaml` can hold tokens, and
`data/profile/` your profile. On Linux the containers run as `PUID:PGID` (default `1000:1000`), which must own `data/`;
see [host-setup.md](host-setup.md#10-linux). Docker Desktop on macOS maps ownership itself.

Two browser tabs (or a phone and the desktop) editing the same settings form or profile: the second save is refused (the file
was changed elsewhere) and the form shows the saved values, instead of overwriting the first. Every save of a
config file from the web also keeps the previous text in `data/config/.backup/editor/` (the advanced editor's
backups, `ui.yaml: config_editor.backups_keep` copies per file).

## Versions and migrations (`config_version`)

- Each config can carry a top-level `config_version: <integer>`; omitted = 1.
- The code has a current version for each file (the `to` of the last migration step in `src/lib/config/migrations/<file>/NNN-*.ts`).
- A file **older than the code**: it is migrated in memory before validation and works as usual; the doctor suggests running `pnpm config:migrate --write` to write the migration back (comments are kept, the original goes to `.backup/`).
- A file **newer than the code** (the code was rolled back): an explicit error (`ConfigError`, doctor shows a red failure), no guessing. Upgrade the code, or take the pre-migration file back from `data/config/.backup/<timestamp>/`.
- Files in the defaults directory ship with the product and are always at the current version (checked by `config:check`).

Writing a migration (for developers): in `src/lib/config/migrations/<file name>/NNN-slug.ts`, export a `{ from, to, description?, migrate(doc) }` (`to = from + 1`; `migrate` edits the yaml `Document` in place, keeps comments, and does no I/O), register it in order in `CONFIG_MIGRATIONS` in `migrations/index.ts`, and change the default-directory copy of the file to the new format with the new `config_version`. The contract is in `src/lib/config/migrations/types.ts`.

## Shipped config identity

The shipped defaults directory (`config/`, or `JOB_RADAR_DEFAULTS_DIR`) has an identity: a sha256 over a manifest of its
files, one line `<sha256>  ./<relative path>` per regular file, sorted by path in byte order (`LC_ALL=C`). `.DS_Store` and
`._*` files are left out at any depth; a symbolic link, or a file name with a newline or a backslash, is an error. People see
the first 12 characters. The same identity from the shell, in the directory:

```bash
cd config && find . -type f ! -name .DS_Store ! -name '._*' | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum
```

(on macOS without `sha256sum`, use `shasum -a 256`). Any change to a shipped file, a rename, an added or a deleted file
gives a new identity.

- `pnpm config:check` prints it after the profile line: `shipped:  config  c86995b8f48f` (the directory, then the short id).
  A directory that cannot be identified is a failure of `config:check`.
- The running processes report the identity they run with, in the database (`runtime_state` key
  `shipped_config:<web|runner|ai-worker>`: the full id, the directory, the host name, the PID and the process start; the
  row's time is the database clock). The web reports at start-up and, until one write worked, again on each `/api/health`
  request (each attempt limited to `schedule.yaml doctor.probe_timeout_seconds`, so a stuck write is abandoned and
  retried); the runner and the ai-worker (as a service) report at start-up and refresh the report with every heartbeat,
  under the heartbeat's time limit. A failed report is only a warning in that process's log (`could not report the
  shipped config`); it never stops the process or fails a heartbeat.
- `pnpm run doctor` check `config.shipped` (group "data") shows the identity of each process and checks that each report
  comes from the process running now: for web and runner (when they are in `doctor.compose_services`), the report's host
  name is the start of the running container's id, and the report was written no earlier than the container's start
  minus `schedule.yaml doctor.shipped_report_skew_seconds` (default 2, for the clock difference between Docker and the
  database); for the ai-worker (with `ai.yaml execution: host`), the report is newer than `host_worker.offline_after_seconds`
  and its PID is the one launchd (`launchctl print`) or systemd (`systemctl --user show -p MainPID`) gives for the service.
  When the service manager gives no PID, the report cannot be matched. The ai-worker's report must also come from a
  release directory of this checkout (`<checkout>/data/releases/ai-worker/<commit>/config`) whose commit is the
  checkout's HEAD: a worker from outside `data/releases/ai-worker/` (installed by a version from before release
  directories) or from another commit (after a worker-only rollback, or a deploy that stopped before its ai-worker step)
  is a warning with its own hint. Everything that cannot be confirmed is a warning
  that names each process; there is no failure. Without the database the check is skipped. The check also warns when a
  running container of the project has something mounted on `/app/config` (or below it): that would hide the defaults in
  the image, typically a `compose.override.yaml` from before they moved into the image; remove the mount and deploy.

Container reports can arrive late just after a deploy or restart: wait a minute and run the doctor again.
For the ai-worker, check whether `aiworker.heartbeat` says its current process is not confirmed yet; if its report stays
missing, look for "could not report the shipped config" in `data/logs/ai-worker.out.log`.

The ai-worker's release directories and its switch are set by four keys in `schedule.yaml`. None of them is in the
shipped file; add one to `data/config/schedule.yaml` only to change it (a version from before release directories does
not know them, see [upgrade.md](upgrade.md#downgrade-pre-release-dir)):

| Key | Default | Meaning |
|---|---|---|
| `deploy.ai_worker_releases_keep` | 3 | Release directories kept after a switch, the installed and the previous one included (at least 2) |
| `deploy.ai_worker_stop_timeout_seconds` | 60 | launchd `ExitTimeOut` / systemd `TimeoutStopSec` of the worker (at least 10) |
| `deploy.ai_worker_swap_timeout_seconds` | 120 | Longest wait of each phase of a switch (at least the stop timeout + 10), and the step 11 wait cap (`--settle` overrides it) |
| `doctor.shipped_report_skew_seconds` | 2 | Clock difference allowed between Docker and the database when `config.shipped` matches a container's report |

Details: [deploy.md](deploy.md), "The ai-worker runs from a release directory".

## Company filter and overview (`ui.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `filters.company_options_max` | 500 | Companies loaded into the company filter of `/jobs` (the ones with the most jobs); 1 to 5000 |
| `filters.company_options_visible` | 50 | Companies shown before you type in the drop-down's search box; 1 to 5000 |
| `companies.page_size` | 50 | Rows per page of `/companies`; 1 to 500 |

These keys may be missing (the defaults apply); a file without them needs no migration. The `companies` block may also be
omitted. Edit the overview page size in YAML or the advanced editor.

Rolling back to a version without the company filter: `interests.yaml` views and `ui.yaml` are strict, so the older
version refuses a file that holds the new keys (and the push step cannot read `interests.yaml` either). Before switching:

1. Stop writing: `docker compose -p job-radar stop web runner`, and let a cycle that is running finish.
2. Back up `data/config/interests.yaml` and `data/config/ui.yaml`.
3. Remove every `company:` key from the views in `interests.yaml`.
4. Remove `filters.company_options_max` and `filters.company_options_visible` from your `ui.yaml`, and the whole
   `companies:` section, even if you never added it (saving the settings writes it back with its defaults; leaving
   `companies: {}` is refused as well).
5. Check both files with the older version (`pnpm config:check` or `pnpm run doctor` in its image).
6. Switch to the older image and start the services.

Rolling back only the company overview (to a version that has the company filter but no `/companies`): do steps 1,
2, 5 and 6, and in between remove the whole `companies:` section from your `ui.yaml`; views and the `filters.*` keys stay.

The shipped `ui.yaml` is part of the image, so it goes back with it.

## Recheck of watched jobs (`pipeline.yaml` + `ui.yaml`)

The maintenance step rechecks the posting pages of starred and followed jobs (see usage.md "Closed jobs"). Its keys
live in two files; the watched-recheck blocks may be missing (older files): the defaults below apply. The table also lists
the link-check settings shared by possibly-closed and unseen active jobs.

| File | Key | Default | Meaning |
|---|---|---|---|
| `pipeline.yaml` (shipped) | `lifecycle.possibly_closed_after_days` | 7 | Days unseen before marking possibly closed, only when every source channel has had a successful run since the deadline |
| | `lifecycle.dormant_after_days` | 30 | Days possibly closed before dormancy; integer 0–3650. 0 disables it and wakes existing dormant jobs at the next maintenance sweep. Optional, supplied by the schema when absent; the shipped file contains only a comment |
| | `lifecycle.unseen_link_check_after_days` | 14 | Days unseen before an active job gets a direct fallback link check, regardless of channel runs; 0 = off. Optional, supplied by the schema when absent |
| | `lifecycle.unseen_link_check_interval_days` | 7 | Least days between fallback checks of the same job. Optional, supplied by the schema when absent |
| | `lifecycle.max_link_checks_per_cycle` | 20 | Shared per-cycle cap for possibly-closed and unseen active jobs' link checks |
| | `lifecycle.link_check_timeout_ms` | 10000 | Per-request timeout for both kinds of link check |
| | `lifecycle.watch_recheck.interval_hours` | 72 | A watched job is rechecked at most once in this many hours |
| | `lifecycle.watch_recheck.max_per_cycle` | 10 | Jobs rechecked per run |
| | `lifecycle.watch_recheck.per_host_min_interval_ms` | 3000 | Least time between two requests to one site (robots.txt included) |
| | `lifecycle.watch_recheck.timeout_ms` | 10000 | Per request |
| | `lifecycle.watch_recheck.max_body_bytes` | 1048576 | Longest page read; the rest is not downloaded |
| | `lifecycle.watch_recheck.user_agent` | `JobRadar/2 (self-hosted job tracker; link check)` | Sent with watched rechecks and plain link checks of possibly-closed and unseen active jobs; its first word is the robots.txt product token |
| `ui.yaml` (user) | `job_checks.closed_recheck.enabled` | `true` | Off: no watched recheck (plain link checks of possibly-closed and unseen active jobs keep running) |
| | `job_checks.closed_recheck.extra_phrases` | `[]` | Your phrases (regex, case-insensitive), added to the packs' `closed_posting.phrases`. Only a safe subset is accepted: words, character classes, alternation `(a\|b)`, `\b`, optional parts `?` (at most 8) and `{n,m}` up to 5, at most 200 characters; no `*`, `+`, `{n,}` or backreferences. `pnpm config:check` names an invalid or unsafe one by its path. They search at most the first 200,000 characters of a page's visible text, within 250 ms per page (a page whose search runs out of time counts as not checked) |

The `ui.yaml` block is edited in the YAML or the advanced editor (no form). An older version rejects it: remove it before
rolling back.

Dormancy needs no config version bump or file migration: the new optional key has only a schema default and is not
written into user files by `config:migrate --to-full`. To roll back, remove `lifecycle.dormant_after_days` from your
user `pipeline.yaml` if you added it: older strict schemas reject it. Keep the database migration; older code ignores
the nullable markers and shows dormant jobs again. Re-upgrading sweeps stale markers and restores protection.


## Ghost job check (`pipeline.yaml` + `ui.yaml`)

Signs that a posting is not a real opening (see [ghost-jobs.md](ghost-jobs.md)). Off by default; both blocks may be
missing: the defaults below apply. The phrases live in the market packs (`rules.yaml` `ghost`, see
[market-packs.md](market-packs.md#ghost-job-patterns)).

| File | Key | Default | Meaning |
|---|---|---|---|
| `pipeline.yaml` (shipped) | `job_checks.ghost.per_cycle_limit` | 2000 | Jobs checked per cycle at most |
| | `job_checks.ghost.levels.watch` / `.likely` | 3 / 5 | Points for "watch" / "likely ghost" (1–50, watch ≤ likely); "likely" also needs a reason that is not about time or length |
| | `job_checks.ghost.long_open.tiers` | `[{days: 90, points: 1}, {days: 180, points: 2}]` | Days open since the trusted posted date and their points (1–10 tiers, ascending days 1–3650, points 0–10) |
| | `job_checks.ghost.long_open.first_seen_max_points` | 1 | Most points when only the first-seen date is known (0–10) |
| | `job_checks.ghost.repost_label.points` | 1 | The source labels it "Reposted" (0–10) |
| | `job_checks.ghost.reposted.min_gap_days` / `.points` | 30 / 2 | Relisted by the same source under a new id at the same place at least this many days later (1–3650 / 0–10) |
| | `job_checks.ghost.evergreen_wording.points` | 2 | The JD says talent pool / always open (0–10) |
| | `job_checks.ghost.thin_description.min_words` / `.points` | 120 / 1 | A full-text JD shorter than this, or without a duties section (0–5000 / 0–10) |
| | `job_checks.ghost.thin_description.infer_from_headings` | `true` | Without a current JD breakdown, the duties headings decide whether a long JD has a duties section. `false`: the headings are not read, so only a short JD counts (a current breakdown still decides, an empty duties list included) |
| | `job_checks.ghost.<signal>.enabled` | `true` | Each signal can be turned off |
| | `job_checks.ghost.quote_max_chars` | 280 | Longest quote (40–2000) |
| | `job_checks.ghost.negation_words_before` / `_after` | 6 / 5 | Words around an evergreen phrase searched for a negation (0–20); a pack with `negation_after: clause` searches after it to the end of the clause instead |
| | `job_checks.ghost.heading_max_chars` | 60 | Longest line read as a heading together with the next line (10–200) |
| | `job_checks.ghost.question_tag_max_words` | 6 | Most words of an invitation tagged on after a statement that keeps it a statement ("We are always hiring – want to join?"; 1–20); the invitations are the packs' `question_tag` ([market-packs.md](market-packs.md#ghost-job-patterns)) |
| `ui.yaml` (user) | `job_checks.ghost.enabled` | `false` | On: the cycle checks jobs and the pages show the marks and the filter |
| | `job_checks.ghost.trusted_companies` | `[]` | Company names never marked (matched by the normalized name, without the legal form, aliases applied); their marks disappear at once, closed jobs included |

An older version rejects `job_checks.ghost` in `ui.yaml`: remove it before rolling back.

## Visa check (`pipeline.yaml` + `ui.yaml`)

What a posting says about visa sponsorship (see [visa-sponsorship.md](visa-sponsorship.md)). Both blocks may be missing:
the defaults below apply. The patterns live in the market packs (`rules.yaml` `visa`, see
[market-packs.md](market-packs.md#visa-patterns)).

| File | Key | Default | Meaning |
|---|---|---|---|
| `pipeline.yaml` (shipped) | `job_checks.visa.per_cycle_limit` | 2000 | Jobs checked per cycle at most |
| | `job_checks.visa.max_quotes` | 3 | Quotes kept per job (1–10) |
| | `job_checks.visa.quote_max_chars` | 280 | Longest quote (40–2000); a longer sentence is cut around the phrase |
| | `job_checks.visa.negation_words_before` | 6 | Words before an "offered" phrase searched for a negation (0–20) |
| | `job_checks.visa.negation_words_after` | 5 | Words after it, up to the end of its clause, searched for a negation (0–20) |
| | `job_checks.visa.heading_max_chars` | 60 | Longest line read as a heading together with the next line (10–200) |
| `ui.yaml` (user) | `job_checks.visa.enabled` | `true` | Off: nothing is checked and no page shows it |
| | `job_checks.visa.badges` | `auto` | When the list badge and the /jobs filter show: `auto` (only when me.yaml `needs_visa_sponsorship` is true), `always`, `never` |

An older version rejects `job_checks.visa` in `ui.yaml`: remove it before rolling back.

## Log level (`schedule.yaml` `logging.level`, `JOB_RADAR_LOG_LEVEL`)

The web app, the runner, the ai-worker and `pnpm cycle:run` log at `info` unless told otherwise. `debug` adds the
diagnostic records: AI provider checks, a provider the router skipped, HTTP retries, a Telegram message from another chat.

| Where | Value | Meaning |
|---|---|---|
| `JOB_RADAR_LOG_LEVEL` in `.env` | `debug`, `info`, `warn`, `error` (case does not matter) | Wins over the config. Empty = not set. Any other value counts as not set (the config applies) and is reported once in the log, without the value |
| `schedule.yaml` `logging.level` | same, default `info` | Used when the variable is not set. Not in the shipped file: the default applies until you add it |

- **Add it to your existing `data/config/schedule.yaml`**, for example `logging:` with `level: debug` under it. A user
  file replaces the shipped one as a whole (see "Which copy is read"), so a `schedule.yaml` holding only a `logging`
  block is invalid.
- **A change to the file needs no restart.** The runner and the ai-worker follow it through their watcher (on Docker bind
  mounts file events are unreliable; the polling picks it up instead); the web app checks on demand, at most once per
  `JOB_RADAR_CONFIG_POLL_MS`. With `JOB_RADAR_CONFIG_POLL_MS=0` the web app does not check on demand: it takes a change
  made outside it only after a restart or when it writes the file itself (a save in Settings). Each process asks for
  the level again at most once per that interval (5 seconds when the interval is `0`), so it takes effect within a few
  seconds of the reload.
- **A broken `schedule.yaml`** keeps the last valid level until the process restarts (the loader keeps the last valid
  file). A process that starts with a broken file logs at `info`, says so once, and takes the level as soon as the
  file is valid again.
- **A change to `.env`** needs the containers recreated, `docker compose up -d` (a `restart` keeps the old
  environment), and the ai-worker restarted (it reads `.env` when it starts). A variable set only in your shell does not
  reach the containers.

Before rolling back to a version without `logging.level`, remove the `logging` block from `data/config/schedule.yaml`:
older versions reject unknown keys.

## Backup

Every backup, the runner's daily one (`backup.config_archive`, on by default) and `scripts/ops/backup.sh`, leaves a `….config.tgz` (`data/config` + `data/profile`, without `.backup/` and the sign-in key `.web-session-secret`) next to the database dump. The `backup` section of `schedule.yaml` also has `pre_migrate` (take a backup before a database migration), `keep_system` (how many safety backups of each kind to keep) and `keep_old_databases` (how many databases replaced by a restore to keep). `.env` and `.auth/` are in no backup. See [`backup-restore.md`](backup-restore.md), including "Restoring the configuration".

## Switching from a single directory

Older versions kept the live configuration in git as `config/`. Preserve a separate copy of that live directory before
switching code. With old consumers stopped, import it using `pnpm config:init --from <saved-old-config-dir>` before
deploy fills missing user files. Existing installs preview and validate before freezing at step 4; step 11 (`config-write`) fills
missing files and writes migrations after excluding old workers. From then on the web app writes `data/config/`, and
`config/` holds product defaults. See sections 4 and 5 of [`deploy.md`](deploy.md) and [upgrade.md](upgrade.md).

### Upgrade write protection

`pnpm ops:freeze --target <commit>` freezes config/profile writes for an upgrade; `pnpm ops:unfreeze` removes the marker
under the same cross-process write locks and prints `pnpm config:init`, then `pnpm config:migrate --write`. Use it only
after confirming no old consumers remain. Before step 8 starts containers, a failure or interrupt automatically removes
only a freeze this run created fresh. A taken-over marker stays until `config-write` passes the consumer checks or the
user runs `ops:unfreeze`; once `up` has been attempted, failures and interrupts keep every marker. Freeze-aware web versions show
an upgrade message on saves while frozen; the older web on the first upgrade continues writing harmless old-format files
until step 8. The doctor
checks leftover markers and write leases/guard owners older than the stale threshold with `config.freeze`. Abandoned
locks are taken over automatically on the next write; if saves keep failing, confirm the owner is no longer writing,
then remove the lock file or guard owner. `pnpm config:migrate --json` reports pending/problem counts without writing.
Lock timing is configured by `schedule.yaml` `deploy.config_write_lock_stale_seconds`, `config_write_lock_wait_seconds`
and `config_write_lock_retry_ms` (defaults: 300 seconds, 10 seconds, 50 milliseconds). Same-host owners carry a random
process ID and process start time; a reused PID or abandoned token is recovered immediately, while live owners stay busy.
A foreign host/namespace can be taken over only after the stale threshold.
The final commit checks lock ownership again.
See [upgrade.md](upgrade.md#settings-during-an-upgrade) for recovery and host-process restarts.
