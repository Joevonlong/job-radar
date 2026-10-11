# Images

`brand/` holds the README header (light and dark, English and Chinese). The feature clips (`.webp`) shown in the README
are hosted on the project website (`https://joevonlong.github.io/job-radar-site/readme/`), so the repository stays
small.

The static screenshots and the demo GIF here are generated, never edited by hand:

| File | What it shows |
| --- | --- |
| `today-light.png`, `today-dark.png`, `today-zh.png` | Today, light / dark / Chinese (1440×900) |
| `job-detail-light.png`, `job-detail-dark.png`, `job-detail-zh.png` | A job: score, salary quoted from the JD, an AI trap (1440×1320) |
| `pipeline.png` | The application board, every column with a card (1760×900) |
| `settings.png` | Settings, search tab, with the "AI engineering in Europe" example (1440×900) |
| `mobile-today.png` | Today on a phone (390×844) |
| `telegram.png` | A push message as `formatJobMessage` writes it, in a plain preview frame (not Telegram's own artwork) |
| `job-radar-demo.gif` | About 20 seconds: Today → a job → its salary sentence → Mark applied → the board (960 px wide, looping) |

## Regenerating

```bash
DEMO_ADMIN_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5433/postgres pnpm demo:shots [--env-sentinel] [--allow-missing-patterns]
```

- **Needs:** Docker Postgres (or any server where the role may `CREATE DATABASE`), ffmpeg, the Playwright browsers
  (`pnpm exec playwright install chromium`). Optional: `pngquant` and `oxipng` compress the PNGs.
- **What it touches:** only a database named `jobradar_demo*` (`DEMO_DB_NAME`) and directories under the system temp
  directory whose path contains a `job-radar-demo*` directory (`DEMO_CONFIG_DIR`, `DEMO_PROFILE_DIR`, default
  `<temp>/job-radar-demo/`); anything else is refused before it is written or removed. Port `DEMO_PORT` (default 3190).
  The database and directories are removed at the end, also when the run fails. It also runs `pnpm build`, which
  writes the repository's `.next/`: do not run it while `pnpm dev` or `pnpm start` is running in the same checkout
  (`DEMO_SKIP_BUILD=1` reuses an existing build).
- **Environment:** `data/` is not read, and every variable named in `.env.example` (plus the demo's own) is set empty
  for the server. That is the limit of the isolation: Next.js still loads `.env*` files for any *other* variable name,
  so a variable that exists only in your `.env` and is read by the app would reach the demo. `--env-sentinel` checks
  the `.env.example` names; keep new variables in `.env.example`.
- **Data:** `pnpm db:seed`'s fictional data plus an "interviewing" and an "offer" application, one AI trap, a fully
  successful newest run, one-sentence summaries and a real provider / model id on the AI rows
  (`src/lib/db/seed-demo.ts`; the paid LinkedIn source is off in the demo config), a fictional profile (`scripts/demo/profile/`), "now" fixed at 10:00 Berlin time. The
  profile page (`/me`) is not shot.
- **Guard:** before each picture, the page's markup (including `title` attributes and form values) and every response
  it loaded are checked for the home directory, user name, host name, temp and repository paths, tailnet host names,
  real-looking e-mail addresses and the private strings of `.release-check.local`. The strings file is looked up as
  `RELEASE_CHECK_PATTERNS_FILE`, then `.release-check.local` in this checkout, then in the main checkout (so a git
  worktree finds it). `demo:shots` requires it by default (`--require-patterns`): without it the run stops before
  starting; `--allow-missing-patterns` runs with the generic checks only and prints a warning. The log says how many
  strings were loaded. A hit stops the run and writes no picture.
- **What the guard does not see:** JavaScript, CSS and font files, canvas drawings, iframes and the pixels of the
  pictures themselves (text drawn into an image is not read). Only the HTML markup and the text of the responses the
  page loaded are checked. `--env-sentinel` (only without a `.env`) also writes a `.env` full of a sentinel
  value, checks it never shows up, and removes it.
- **Budgets:** all PNGs together at most 5 MB, the GIF at most 5 MB (otherwise one retry at 800 px / 8 fps, then a
  failure). Over the PNG budget the run fails when pngquant or oxipng is installed, otherwise it warns.
- **Output:** pictures go to a staging directory first and move here only after the whole run passed. The recorded video
  and an mp4 for posts stay in `.local-demo/` (ignored by git).
- **Same day, same pictures:** a second run on the same day gives the same files at the same pixel sizes (dates in the
  pictures follow the day of the run).

Files: `playwright.shots.config.ts`, `e2e-demo/`, `scripts/demo-shots.sh`, `scripts/demo-prepare.ts`,
`scripts/demo-finish.ts`, `scripts/demo/`.
