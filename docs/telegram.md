# Telegram push

After every cycle, the host `ai-worker` pushes qualifying new jobs to your Telegram (the runner only receives the button clicks, so if nothing arrives check that the ai-worker is running); under each message there are three buttons, 👍 Interested / 🚫 Ignore / 📄 Tailor résumé (the résumé button only appears once resume-kit is configured, see [resume-kit integration](resume-kit.md)), and clicking one writes into the application record (the same data as the board); a second row has a ⭐ Save that only adds a star. The runner receives the buttons by long-polling (`getUpdates`), so **no public port is needed**.

## 1. Set it up with one command

1. In Telegram find `@BotFather`, send `/newbot`, follow the prompts to name it, and copy the token it gives you (shaped like `123456:ABC-...`).
2. On the computer that runs Job Radar, in the project folder, run:
   ```bash
   pnpm run setup --step telegram
   ```
3. Paste the token when asked (it is not shown while you type). The command checks it with Telegram and shows the bot's name.
4. Send any message to your bot (or, for a group, add the bot to the group and send a message there). The command finds the chat, shows its name and asks you to confirm; if nothing arrives in time (`telegram.setup.wait_for_message_seconds` of `notify.yaml`, 180 s), you can type the chat id yourself. Only a message sent after the prompt is taken by default: a message that was already waiting (maybe old, maybe from someone else) is offered only when no new one came, marked as such, and only taken when you answer yes.
5. For a group chat it asks who may press the buttons, defaulting to the person who just wrote (you); see "Group chats" below.
6. It sends a test message and asks whether it arrived, shows a summary (the chat id is masked, the token never shown), and writes `.env` after you confirm.
7. It offers to switch the push on (`telegram.enabled` in `notify.yaml`) and then restarts the services so they read the new values, and checks the result (see below).

You can also reach this step from the full `pnpm run setup` interview. Settings → Notifications and the setup wizard in the web show whether the bot is set up (only which variables are set, never their values), the last test message and the same command; the web itself never reads or changes the token.

### What it writes

- Only `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `TELEGRAM_ALLOWED_USER_IDS` in `.env`; every other line stays as it was.
- Before changing `.env` it saves a copy next to it (`.env.backup-<time>`, readable only by you, gitignored); the new file is written in one step with mode 600. If there is no `.env` yet, it starts from `.env.example`. When `.env` is a symlink, the file it points to is changed and the link stays.
- A changed line keeps its `export ` prefix and a trailing ` # comment`.
- **The backup still holds the previous values, the old token among them.** After replacing or removing a bot, delete it once everything works (`rm .env.backup-<time>`; the command prints the exact name). Otherwise the old token stays on disk.
- The token never appears on screen, in logs or in the answers file of `pnpm run setup --answers`.

### When a bot is already set up

Running the command again shows the current bot and the masked chat id and asks what to do: **keep** it, **replace** it (new token or new chat), send a **test** message only, or **remove** it (empties the three variables, switches the push off and restarts).

### Restarting the services

The web and the runner read `.env` only when their container is created, and the host ai-worker when it starts. So after writing `.env` the command:

- recreates the `web` and `runner` containers that are running (`docker compose up -d --no-deps --force-recreate --wait`, compose project from `COMPOSE_PROJECT_NAME`, else `doctor.compose_project` of `schedule.yaml`);
- restarts the ai-worker when it is installed and running (`launchctl kickstart -k` on macOS, `systemctl --user restart` on Linux);
- waits up to `telegram.setup.poller_check_seconds` for the runner to log `telegram poller started`, then runs `pnpm run doctor --only telegram` and shows its lines.

If a restart fails, or you pass `--no-restart`, it prints the commands to run yourself instead, for example:
```bash
docker compose -p job-radar up -d --no-deps --force-recreate web runner
launchctl kickstart -k gui/$(id -u)/<ai-worker label>        # macOS
systemctl --user restart job-radar-ai-worker.service          # Linux
```

**The bot can have only one reader.** The runner polls the bot for button presses, and Telegram allows one poller per token. When you set up again with the token the runner already uses, the command stops the runner while it waits for your message and starts it again afterwards (also when you cancel with Ctrl-C). Button presses made meanwhile are not lost: the command only takes messages and leaves the presses queued for the runner. If another program polls the same bot, Telegram answers "conflict": type the chat id yourself.

Ctrl-C cancels the command, which then puts the services back as they were. The Docker and ai-worker commands run in a process group of their own, so a Ctrl-C never cuts a recreate half-way, and while the services are coming back a further Ctrl-C only prints a note. If a recreate fails and leaves web or runner stopped, the command starts them again and prints the commands to finish by hand.

### Doing it by hand

1. Send a message to the bot, open `https://api.telegram.org/bot<token>/getUpdates` in a browser and find `"chat":{"id":...}`: that number is the chat id (positive for a private chat). Do not share the link containing the token.
2. Write them into `.env` (gitignored; do not commit it or paste it into chat or logs):
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
3. Recreate the containers and restart the ai-worker with the commands above.
4. Test: `pnpm telegram:test`; getting a "✅ Job Radar" message means it works.
5. Telegram is **off by default**. In `data/config/notify.yaml` set `telegram.enabled` to `true` (or switch it on in the setup wizard); the runner hot-reloads this switch, no restart needed.

Only messages and buttons from this chat id are processed; anything anyone else sends to the bot is ignored (at log level `debug` one line is logged, without content; see "Log level" in [configuration.md](configuration.md)).

**Group chats**: when `TELEGRAM_CHAT_ID` is a group or channel (a negative number), every member of the group can press the buttons and change your application statuses. Limit them to yourself by adding your own Telegram user id (a number; `@userinfobot` tells you, and the setup command offers the id of whoever wrote the message) to `.env`, comma-separated for several people, and restart the runner:
```
TELEGRAM_ALLOWED_USER_IDS=123456789
```
Presses from other users are then ignored (they only see a short "not allowed" answer). Unset, everyone in the chat is served, which is fine for a private chat. The doctor (`telegram.allowed_users`) warns when the chat id is negative and the variable is not set.

## 2. What is pushed

All messages, buttons, button answers and alerts are in the Telegram language: `notify.locale` of `language.yaml`, or the
default interface language when it is `null` (see [languages.md](languages.md)). The one-line summary of a job is the one
in that language, else the AI output language, else English.
| Content | Rule |
|---|---|
| Summary (one per cycle) | Cycle type and time, number of new jobs / jobs that passed the filters / qualifying jobs, failed sources |
| Job message | Ranking value >= `push_min_score` (with a high-value signal >= `push_min_score_high_value`; the high-value signal categories are set on `/interests`); new jobs of watched companies are not subject to the threshold (pushed even without a score); jobs removed by hard filters are not pushed; jobs not yet scored are not pushed (watched companies excepted); at most `max_per_cycle` per cycle, the excess is not pushed, look at it on the board |
| Badges | One per signal category the job has, in the order of `/interests`: its icon and its name in the Telegram language (`language.yaml: notify.locale`; another language when it has none), e.g. 📈 Equity; the amount category shows the normalised annual range instead (💰 €85-105k) · 👀 watched company · German B2 required; tag categories and deleted categories do not become badges |
| Alerts | Channel circuit breaker opened, login state expired / LinkedIn verification page, budget 80% / 100%, all AI providers failed, a cycle did not finish; the same kind (type + object) is sent only once within `alerts.dedupe_hours` (24) hours. Job Radar's AI usage cap ([ai-providers.md](ai-providers.md)): one alert when a subscription CLI's window fills or it reports a limit, one when it is usable again; sent on state changes only, `quota_guard.alert_dedupe_hours` (6) stops a flapping state |
| Alerts queued by other features | Other features (such as backup) write unsent `alert.<type>` rows into `notifications`; the next notify step sends them and backfills the message id; they are likewise deduplicated for 24 hours by type + `key` (duplicates are simply marked handled, not sent) |
| Application reminders | One per day (`reminders.send_at`, default 09:00 in the `schedule.yaml` time zone): "Interested" for more than `interested_days` days without applying, "Applied" for more than `applied_days` days without a reply; nothing is sent if there are none that day |

Quiet hours (`quiet_hours`, default 22:00-07:00, in the timezone of `schedule.yaml`): summaries and job messages wait until the first cycle after quiet hours ends (after a job first appears, or after it gets a score, it remains a candidate for `candidate_window_hours` (48) hours: an older job that got its score late through "Score now" or backlog scoring will also be pushed in the next cycle if it reaches the threshold); alerts are not affected by default (`alerts_exempt`); an application reminder that falls inside quiet hours waits until quiet hours end.

## 3. Buttons
| Button | Application status | Notes |
|---|---|---|
| 👍 Interested | `interested` | Changes only from "New / Archived"; statuses that have moved further are not overwritten |
| 🚫 Ignore | `archived` | Changes only from "New / Interested / Preparing" |
| 📄 Tailor résumé | `preparing` | Exports the JD to resume-kit (the same export function, and sends the `/tailor` command back, see [resume-kit integration](resume-kit.md)) |
| ⭐ Save / ☆ Unsave (second row) | Does not change the application status | Only writes / deletes the favorite (the same data as the web `/favorites`); a line "⭐ Saved" is added to / removed from the end of the message and the **button stays**: the second row toggles between "⭐ Save" and "☆ Unsave", and repeated clicks are safe; unsaving in Telegram has no undo, to get it back click ⭐ Save again (a note written on the web is lost) |

After a status button (👍 🚫 📄) is clicked the message is edited to "Marked" and the buttons disappear (if the job is favorited, a "⭐ Saved" line remains under the mark); the ⭐ Save button does not make the buttons disappear. Clicking the same button again is safe (the timeline is not recorded twice). Messages sent before this redesign keep working as before.

## 4. Troubleshooting
- `pnpm telegram:test` reports `chat not found`: the chat id is wrong, or you have not pressed Start in the bot.
- Settings → Notifications says "Not connected" although `.env` has the values: the web container was not recreated after `.env` changed (a plain `docker compose restart` keeps the old values): recreate it with the commands above.
- Button callbacks do not arrive: one bot can have only one `getUpdates` consumer; if another program uses the same token (or a webhook is set) you get 409, and in the runner log you see `getUpdates failed` followed by an automatic back-off retry.
- The token never appears in logs or error messages (a `[token]` placeholder appears instead).
