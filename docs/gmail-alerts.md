# Gmail job alert emails

The `gmail-alerts` channel reads the job alert emails that LinkedIn, StepStone, Indeed and XING send to your Gmail, and turns the job cards in each email into job data. These platforms have already filtered by the keywords and cities you subscribed to, and this path **never touches any platform's anti-bot defences**, so it only needs read-only access to one label and never sends or deletes mail.

## What it does and does not do
- IMAP (imapflow) plus an app password, **read-only** on one label (default `JobAlerts`): it opens the mailbox read-only with `EXAMINE` and reads message bodies with `BODY.PEEK`. It **does not mark as read, move, delete or label**; the code contains no call that writes to the mailbox.
- The parser is chosen by sender domain (`sources.gmail.senders` in `sources.yaml`). Each job card in an email -> one raw posting (title, company, location, link; salary and summary if present).
- Processed Message-IDs are recorded in the database table `email_messages`, so each email is read only once.
- Parse failure (layout changed, no HTML part, no job cards recognised): the whole email is stored (`raw_postings`, kind `email_unparsed`) marked `parse_failed`, with the reason in `parse_error`; other emails are processed as usual. A card without a company name is individually marked `parse_failed` (the company is never guessed).
- Emails in the label that do not belong to these four platforms: the body is not read and nothing is stored except one row in `email_messages` (`parse_failed`), so they are not re-checked every cycle.
- When the same job also appears on other channels (company ATS, LinkedIn, ...), cross-source merging combines them into one job; the link from the email counts as one source (priority: `pipeline.yaml: apply_priority.email`, default 4, the lowest).
- No OAuth.

## 1. Turn on 2-step verification and create an app password
1. Google Account -> Security -> turn on "2-Step Verification".
2. Open <https://myaccount.google.com/apppasswords> (this entry exists only with 2-step verification on), give it any name (for example `job-radar`), and generate a 16-character app password. Google shows it with spaces; with or without them both work.
3. Gmail settings -> Forwarding and POP/IMAP -> make sure "IMAP access" is enabled (on by default for new accounts).
4. Write it into `.env` (gitignored; never commit it or paste it into chat or logs):
   ```
   GMAIL_USER=your full email address
   GMAIL_APP_PASSWORD=app password
   ```
   When you no longer need it, revoke the password on the same page.

## 2. Create the `JobAlerts` label and filter
1. In the Gmail left sidebar choose "Create new label" -> name it `JobAlerts` (if you rename it, change `sources.gmail.label` too; a Gmail label is the IMAP folder name, and nested labels are written `Parent/Child`).
2. In the search box choose "Show search options" -> put the string below in "From", and click "Create filter":
   ```
   jobalerts-noreply@linkedin.com OR jobs-listings@linkedin.com OR alert@indeed.com OR noreply@jobalert.indeed.com OR jobs@stepstone.de OR noreply@stepstone.de OR no-reply@mail.xing.com OR jobs@xing.com
   ```
   Use the sender addresses of the alert emails you actually receive (open one and look at "From"); `sources.yaml` matches by domain (`linkedin.com`, `stepstone.de`/`.com`/`.at`, `indeed.com`, `xing.com`, subdomains included), so if an address changes but the domain does not, no config change is needed.
3. Tick "Apply the label: JobAlerts". You can also tick "Skip the Inbox" (read the jobs only on the board); the channel does not depend on read / unread state and never changes it.
4. Tick "Also apply filter to N matching conversations" to put the historical alert emails into the label too.

## 3. Subscribe to alerts on the four platforms
Keep keywords and cities consistent with `data/config/search.yaml` (keyword groups x `locations` + remote). Daily frequency is enough; real-time alerts produce too many emails, and `max_messages_per_cycle` defaults to reading only 50 per cycle.

| Platform | Where to subscribe |
|---|---|
| LinkedIn | Search jobs -> "Set alert" on the left or top right -> frequency Daily, channel Email |
| StepStone | Search results page -> "Job-Alert erstellen" -> frequency daily |
| Indeed | Search results page -> "Receive new jobs for this search by email" / "Neue Jobs per E-Mail erhalten" |
| XING | Job search -> "Suchauftrag speichern" -> turn on email notifications |

## 4. Configuration (`data/config/sources.yaml` -> `sources.gmail`)
| Key | Meaning |
|---|---|
| `enabled` | Switch; set to `true` once `.env` and the label are ready (the runner hot-reloads config, but after writing `.env` for the first time restart the runner once) |
| `host` / `port` / `secure` | IMAP server, default `imap.gmail.com:993` with implicit TLS; `secure: false` is only for connecting to a local test server |
| `label` | The one label that is read |
| `max_messages_per_cycle` | Maximum emails read per cycle (newest first); the rest wait for the next cycle |
| `lookback_days` | Only look at emails received in the last this many days (default 14) |
| `max_results` | Maximum jobs produced per cycle. An email is never split in half: once the limit is exceeded no new email is started |
| `timeout_ms` | Connection / greeting / socket timeout |
| `senders` | Platform -> list of sender domains |

## 5. Live smoke test
```bash
# 1) data/config/sources.yaml: sources.gmail.enabled: true; GMAIL_USER / GMAIL_APP_PASSWORD set in .env
pnpm cycle:run --channel gmail-alerts --dry-run      # reads the mailbox only, parses in memory, writes nothing; an open circuit skips it as in a real run (cascade has no available channel)
pnpm cycle:run --channel gmail-alerts                # actually stores (email_messages / raw_postings / jobs)
```
The dry run lists the number of parsed jobs and the first few titles; if K in `parsed N/M (K failed to parse)` is not 0, some email layout was not recognised: look in `raw_postings` for `parse_status = 'parse_failed'` and read the original (`payload_json->>'reason'`).

## 6. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Source card "Not configured" (no run record, no request) | `GMAIL_USER` or `GMAIL_APP_PASSWORD` is not set in `.env`, or the runner was not restarted |
| `auth_expired`: Gmail rejected the login | The app password is wrong or revoked; make sure 2-step verification is still on; `GMAIL_USER` must be the full address |
| `the configured Gmail label does not exist` | The label name differs from `sources.gmail.label` (case-sensitive; nested labels are written `Parent/Child`) |
| `network` | Cannot reach `imap.gmail.com:993` (firewall / network); the channel's circuit breaker handles it per `circuit_breaker` |
| A platform never yields jobs | Look for `no <platform> job cards recognised` in the log: that platform changed its email layout, the original is already stored (`parse_failed`); redact the email's HTML, add it to `tests/fixtures/email/`, then fix the parser |
| Logs / error messages | Contain no account or password; only IMAP error codes |

## 7. Parsers and samples (developers)
- Parsers live in `src/lib/channels/email/parsers/` (one file per platform) and share the card discovery in `html.ts`: find links that point to a job (the platform job id is in the link) -> group by job -> take the largest ancestor that contains this group of links and no other job / footer links -> the text lines after the title are, in order, company and location, and the rest, after removing status badges, is the summary. It does not rely on CSS classes (classes in emails are often obfuscated and change often).
- Link normalisation: unwrap redirect wrappers such as `url=`; LinkedIn -> `linkedin.com/jobs/view/<id>/`, Indeed -> `viewjob?jk=<id>`, StepStone / XING drop tracking parameters; links whose id cannot be recognised (for example Indeed sponsored links) use the normalised link as external id.
- Salary is taken only when the email states it; a platform's "Gehaltsprognose / estimate" is not treated as salary.
- `tests/fixtures/email/*.html` are **hand-built samples** based on each platform's publicly visible link format and card structure (fictional companies, no real emails or personal data), see the README in that directory. When a real email's layout differs from the samples, trust the real email and update the samples and parser.
