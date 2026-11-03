# Gmail replies

Job Radar can read the replies companies send about your applications, from **one Gmail label you choose**, and suggest what to change on `/pipeline`: an interview invite suggests moving the card to Interviewing, a rejection to Rejected. **Nothing changes until you press Confirm.**

It is off by default (`replies.yaml: enabled: false`). While it is off the mailbox is not opened.

## What it does and does not do

- Reads only the label in `replies.yaml: label` (default `JobReplies`), never the whole inbox. It opens the label read-only with `EXAMINE` and reads bodies with `BODY.PEEK`: nothing is marked read, moved, labelled or deleted, and it sends no mail.
- Decides with local rules (regular expressions in `replies.yaml`). **No AI reads these mails, and no mail content leaves your machine.** The Telegram reminder only gets a number and a link to the board.
- Stores per mail: the sender's domain (not the address), the date, the subject, one short quote, the category, the match and your decision. Not the body, not attachments. A message over `max_message_bytes` is not downloaded: only its headers are judged. Mail from your own `GMAIL_USER` is skipped.
- A decided reply loses its subject and quote after `storage.decided_retention_days` (default 90); a reply still waiting keeps them. Logs hold counts and categories only.
- Only visible text counts: white text, zero-size text and other hidden parts of an HTML mail are dropped before the rules and the quote. If a mail holds something that looks like an instruction to an AI, the row says so.
- The same app password as [gmail-alerts.md](gmail-alerts.md). Be aware that an app password opens the whole mailbox to whoever holds it: Google offers no narrower one, so keep it in `.env`, and revoke it when you stop using this.

## 1. Create the label and filter

1. In Gmail create the label `JobReplies`. Under Settings -> Labels, make sure "Show in IMAP" is ticked for it.
2. Run `pnpm replies:filter`. It prints a Gmail search built from the applicant-tracking senders and your current applications; it reads the database only.
3. Paste it into the Gmail search box, choose "Create filter", tick "Apply the label: JobReplies" and **"Also apply filter to matching conversations"**, otherwise the mail you already have stays outside the label. You can also label a mail by hand; anything under the label within `lookback_days` is read.

Run `replies:filter` again now and then: new applications bring new company names.

## 2. Try it, then switch it on

```bash
pnpm replies:check             # reads the label, stores nothing, prints counts and categories only
pnpm replies:check --eml a.eml # classifies one local file; needs no mailbox and no database
```

If the counts look right, set `enabled: true` in `replies.yaml` (also in `data/config/` with Docker). The next cycle reads the label. `pnpm replies:check --write` stores straight away, and is refused while the feature is off. `pnpm run doctor` shows the state under "Gmail replies".

## 3. Deciding on `/pipeline`

The bar above the board shows how many replies wait, and a card with a waiting reply shows `✉ n`. Open the bar to see each reply with its category, the application it seems to belong to, its quote and what it suggests:

- **Confirm** carries out the suggestion: the status moves (with a note on the timeline), or the next step is set.
- **Dismiss** leaves everything as it is.
- **Category** corrects the rules: the suggestion is worked out again. A mail the rules cannot place is "Not classified", and waits for you to pick one.
- **Application** links the reply to another application, for example when several could fit.
- **Undo** sits under "Recently confirmed" for `panel.undo_days` days. It restores the status (and the time in that status) or the old next step, and removes the event as long as nothing else happened since.

If you moved the application yourself before confirming, your change wins: the suggestion is voided and nothing is written. Acknowledgements and other mails that change nothing are only recorded, without asking.

## What it suggests

Set in `replies.yaml: transitions`. Rejected, Withdrawn and Archived are never moved. By default:

| Reply | Application in | Suggestion |
|---|---|---|
| Interview invite | Preparing, Applied | -> Interviewing |
| Interview invite | Interviewing | Next step: schedule the interview |
| Rejection | Applied, Interviewing, Offer | -> Rejected |
| Rejection | Preparing | Nothing; the row says the link looks wrong |
| Offer | Applied, Interviewing | -> Offer |
| Asks for more | Interested, Preparing, Applied, Interviewing, Offer | Next step: send the materials, with a due date |
| Application received | Interested, Preparing | -> Applied |

A reply is linked only when the evidence (thread, applicant-tracking account, company, sender domain, job title) reaches `match.min_score` and clearly beats the next application (`match.min_margin`). Otherwise it waits with the candidates listed. A mail from before the application began is never linked to it, and an application still in Interested only takes an "Application received".

## Troubleshooting

| What you see | What it means |
|---|---|
| Step `replies` failed: "the configured Gmail label does not exist (replies.yaml: label)" | Create the label, or correct the name; check "Show in IMAP" |
| Step `replies` skipped: `not_configured` | `GMAIL_USER` / `GMAIL_APP_PASSWORD` are not set |
| A reply did not appear | It is not under the label, or is older than `lookback_days` |
| Often "Not classified" or a wrong category | Add wording to `replies.yaml: categories`, per language; add a language by adding a group |
