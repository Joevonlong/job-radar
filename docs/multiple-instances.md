# More than one instance

[English](multiple-instances.md) | [中文](multiple-instances.zh.md)

Job Radar is built for one person: one profile, one set of preferences, one Telegram chat. There is no multi-user mode
inside the app. Two people (or you and a trial of a new version) run **two instances**: two checkouts, each with its own
database, config, profile and port.

## What must differ

A second checkout with the default names would take over the first one's containers and share its database. Before its
first `docker compose up`, give it its own names in its `.env`:

```bash
git clone https://github.com/Joevonlong/job-radar.git ~/job-radar-anna
cd ~/job-radar-anna
cat >> .env <<'ENV'
COMPOSE_PROJECT_NAME=job-radar-anna   # containers and network (overrides name: in compose.yaml)
JOBRADAR_PG_VOLUME=jobradar-anna-pg   # the database volume (the default jobradar-pg belongs to the first instance)
JOB_RADAR_WEB_PORT=3001               # the dashboard: http://127.0.0.1:3001
DB_HOST_PORT=5434                     # the database port on the host (host commands, ai-worker)
ENV
docker compose config | grep -E '^name:|jobradar-|published'   # check the names before starting
docker compose up -d --build
```

| Variable | First instance (default) | Why it must differ |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `job-radar` | Compose finds "its" containers by project name: the same name means the same containers. |
| `JOBRADAR_PG_VOLUME` | `jobradar-pg` | The volume name is global on the Docker host (not prefixed with the project): the same name means the same database. |
| `JOB_RADAR_WEB_PORT` | `3000` | Only one program can listen on a host port. |
| `DB_HOST_PORT` | `5433` | Same. |

**Never change these names for an existing instance**: with a new `JOBRADAR_PG_VOLUME` compose starts an empty database,
and the old one is only reachable again with the old name. The doctor reads `COMPOSE_PROJECT_NAME`, `JOB_RADAR_WEB_PORT`
and `JOB_RADAR_WEB_BIND` from `.env`, and its `compose.project` check warns when the containers of the project name were
started from another checkout.

## What else to keep apart

- **Telegram**: each instance needs its own bot (`TELEGRAM_BOT_TOKEN`); two programs polling one bot steal each other's
  updates.
- **AI worker**: one ai-worker per database. `scripts/ops/install-ai-worker.sh` installs one service per machine user
  (`io.jobradar.ai-worker` on macOS, `job-radar-ai-worker.service` on Linux) for the checkout it is run from; for a second
  instance on the same machine, run `pnpm ai-worker` from its checkout under your own supervisor, or use another machine
  user.
- **Phone access**: `tailscale serve` maps one HTTPS port to one local port; serve the second instance on another HTTPS
  port (`tailscale serve --bg --https 8443 3001`) and set its `notify.yaml: public_base_url` to that address.
- **Profile**: copy settings from one instance to another by copying files from `data/config/`, never `data/profile/`
  (`me.yaml` is the person, `preferences.yaml` what they look for); the new person starts their own profile in the setup
  wizard.
- **Web password**: each instance has its own (`pnpm web:password` in each checkout); sessions of one never open the other.
- **Publishing beyond loopback**: `JOB_RADAR_WEB_BIND` must name the address the instance is actually published on. If you
  open a second instance to the LAN by editing its `ports:` or with a compose override instead, the variable stays
  `127.0.0.1` and that instance still lets requests that claim to be local skip the login; its doctor fails `compose.web`
  ("local login exemption is still on"). See [configuration.md](configuration.md#web-access-optional-password-bind-address-and-port).

## Removing an instance

In its checkout: `docker compose down` (containers and network), then, only if you are sure, `docker volume rm
<its JOBRADAR_PG_VOLUME>`. `docker compose down -v` removes the volume named in **this** checkout's `.env`: run it only in
the checkout whose database you want to delete. See [upgrade.md](upgrade.md#uninstall).
