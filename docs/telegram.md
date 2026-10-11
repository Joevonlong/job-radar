# Telegram push

After every cycle, the host `ai-worker` pushes qualifying new jobs to your Telegram (the runner only receives the button clicks, so if nothing arrives check that the ai-worker is running); under each message there are three buttons, 👍 Interested / 🚫 Ignore / 📄 Tailor résumé (the résumé button only appears once resume-kit is configured, see [resume-kit integration](resume-kit.md)), and clicking one writes into the application record (the same data as the board); a second row has a ⭐ Save that only adds a star. The runner receives the buttons by long-polling (`getUpdates`), so **no public port is needed**.

## 1. Create a bot, get the token and chat id
1. In Telegram find `@BotFather`, send `/newbot`, follow the prompts to name it, and get the token (shaped like `123456:ABC-...`).
2. Open your new bot, press Start, and send any message.
3. In a browser open `https://api.telegram.org/bot<token>/getUpdates`, find `"chat":{"id":...}` in the returned JSON; that number is the chat id (positive for a private chat). Do not send the link containing the token to anyone.
4. Write them into `.env` (gitignored; do not commit it or paste it into chat or logs):
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
5. Test: `pnpm telegram:test`; getting a "✅ Job Radar" message means it works.
6. Telegram is **off by default**. In `data/config/notify.yaml` set `telegram.enabled` to `true` (or switch it on in the setup wizard); the runner hot-reloads, no restart needed (after configuring `.env` for the first time, restart the runner once).

Only messages and buttons from this chat id are processed; anything anyone else sends to the bot is ignored (only one line in the debug log, without content).

**Group chats**: when `TELEGRAM_CHAT_ID` is a group or channel (a negative number), every member of the group can press the buttons and change your application statuses. Limit them to yourself by adding your own Telegram user id (a number; `@userinfobot` tells you) to `.env`, comma-separated for several people, and restart the runner:
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
| Alerts | Channel circuit breaker opened, login state expired / LinkedIn verification page, budget 80% / 100%, all AI providers failed, a cycle did not finish; the same kind (type + object) is sent only once within `alerts.dedupe_hours` (24) hours |
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
- Button callbacks do not arrive: one bot can have only one `getUpdates` consumer; if another program uses the same token (or a webhook is set) you get 409, and in the runner log you see `getUpdates failed` followed by an automatic back-off retry.
- The token never appears in logs or error messages (a `[token]` placeholder appears instead).
