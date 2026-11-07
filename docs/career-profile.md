# Career profile

[中文](career-profile.zh.md)

The optional career profile is a local library of career facts and alternative wordings. You can edit it manually or extract a reviewable draft from your own text. The profile editor does not export résumés. It is independent of the
application writer and does not change matching, scores or the experience library on **My profile**.

## Quick start

1. Enable the career profile as described below, then upload or paste a résumé.
2. Review the extracted draft before adopting it.
3. Add and edit entries by hand.

Later, this profile will support tailored résumés, cover letters and job matching; these uses are not available yet. Profile data stays on this machine; AI extraction sends only the preview text you confirm to your configured provider. The guidance on `/career` can be collapsed once the profile has content.

## Turn it on

Open **Settings → Workflow → Career profile**, enable it and save. A card below the matching profile on **My profile**
links to `/career`. Before the first write, the card says the profile has not been created. While it is on, the sidebar, the phone menu and the command palette also list **Career profile** after
**Pipeline**. Advanced settings also lists `career.yaml`.

Turning it off keeps all saved files and history. Disabled pages and actions do not read or clean the career directory.
A missing or invalid career config closes the feature, including after it was previously enabled. If the profile itself
is unreadable, its card and editor show a readable error message; the rest of My profile continues to work.

## Extract a draft

With the feature enabled, open the career profile and choose **Résumé** or **Self-description**, then upload a PDF, Markdown or text file, or paste text. Prepare the preview before sending. Uploads are read in memory; the file and its name are not saved. File, text and upload limits are configurable.

The preview replaces detected email addresses, phone numbers, links and matching saved contact values with placeholders. It may guess a name; check it, restore it if wrong, or enter a name and address and apply them for removal. Possible phone numbers, saved locations and sensitive labels are highlighted for review. Edit the preview directly and check it carefully: detection can miss details or replace the wrong text, and highlighted text remains unless you remove it. The confirmed text goes to the configured AI provider, not the contact file; detected links are removed, so project links are not extracted. Avoid putting contact details or links back into the preview. A final check may ask you to review again if it changes the text.

The page shows queued and running status, then a draft or an error. If a request times out, fails, or the upload is unsupported, unreadable or too large, follow the displayed message and try again. Only one extraction can run or wait at a time.

Review each suggested field against its source quote and any warning flags. Edit fields, choose which bullets to keep, and select **Add**, **Merge** when a match is suggested, or **Skip** for each entry. Matches are suggestions, so check them. Merging keeps existing facts and adds different text as another wording and new bullets. Save any unsaved profile edits first, then adopt your selections; discard removes the draft without adopting it. Extracted project links must be added manually.

**Add** always creates a separate entry, even when a match exists. Adopting the same draft again adds nothing twice; `adopted_entries` is internal metadata preserved across edits and restores, never edited by users or shown in comparisons. If a PDF is longer than the reading limit, the preview marks it as cut off.

Unreviewed drafts expire after `import.draft_ttl_days` (default 14 days). At `import.max_pending_drafts` (default 5), adopt or discard a draft before starting another. Drafts are stored under `data/profile/career/drafts/` and included in backups.

## Edit facts and wordings

Edit the headline, summary, experience, projects, education, certifications, skills, languages, approach and custom
sections. Custom sections support list, grid and tag layouts, main or aside placement, and entry, text, bullet or tag
items. Dates use `YYYY`, `YYYY-MM` or `present`. Lists such as the technology stack use one value per line.

Company, dates, location and stack are facts shared by every wording. Text fields offer **Another wording**. Set one
wording as primary; only non-primary wordings can be deleted. Select a different primary before removing the current
one. New entries get stable random ids on the server, so changing a title does not change its identity.

**Save profile** writes the complete profile. Save limits are configurable in `career.yaml: profile`: total entries,
bullets per entry, wordings per text and characters per text. The file format has additional hard bounds. Email- or
phone-like text shows a warning, but saving remains allowed; format detection can produce both false positives and
misses. A stale-file message means another save changed the file: reload before editing again.

## Contact details and local files

All career data is under `data/profile/career/` (or the configured profile directory's `career/`):

| File | Contents |
| --- | --- |
| `profile.yaml` | Facts, text and alternative wordings; no contact fields |
| `contact.yaml` | Name, address, location, email, phone, work authorization, availability and contact links |
| `history/profile/<utc>-<sha8>.yaml` | Saved profile versions, newest first in the interface |
| `documents/<id>.yaml` | Independent résumé documents, layout and optional letter; no contact fields |
| `history/documents/<id>/<utc>-<sha8>.yaml` | Saved document versions |
| `preferences.yaml` | Layout defaults for newly created documents, emphasis and tone |
| `photo.png` / `photo.jpg`, `signature.png` / `signature.jpg` | Shared document images |

Files written by the app have mode `0600`. The directory is created on the first save. Contact details have a separate
save button and stale-file check. They are overwritten without history: old contact values are never copied into career
history. The contact photo field is not used; résumé documents use the shared photo uploaded in the document editor.

The contact file is not sent to AI. A city or other personal detail in source text can still be sent if it remains in the confirmed preview. The manual editor sends no career content to AI, Telegram or MCP and writes no database profile snapshots. Profile text can itself contain
contact details; its warning is advisory. Saved files, including contact details, can remain in backups.

## History and restoration

History times use the same display time zone as the rest of the app.

Each changed profile save creates a version. Saving unchanged content creates none. **Compare with current** shows
line additions and removals between a selected version and the current saved profile. **Restore this version** saves
that content again as a new current version; it never rewinds or deletes subsequent history. Save any pending edits first.
Only the most recent `history.keep_versions` versions are kept. If history fails, the profile save still succeeds and
shows a warning that the history version could not be created; check file permissions and free disk space before saving again.

## Apply to matching

The profile itself is not read by scoring or by the application writer. **Apply to matching** at the bottom of the career
page copies parts of it, one way and only when you confirm, into the files those read:

- `me.yaml` (scoring): languages that have both a language code and a CEFR level (others are listed as not applied and
  never guessed), skills with their years (the same name in several groups is merged, keeping the highest years), years of
  experience counted from the experience dates (overlapping periods count once), and the summary (unchecked by default).
  City and visa sponsorship keep their values; contact details and entry locations are never copied.
- `stories.yaml` (the writer): one story per experience, titled "Company – Role", with the summary and bullets as its
  text, the figures in them as metrics and the stack as skills. Text longer than the `writer.yaml` story limits is cut at
  a whole bullet and marked *truncated*. An experience with neither a summary nor bullets gets no story. Your own stories
  are never touched; a profile story you edited after applying is offered unchecked; a profile story whose experience
  left the profile is kept unless you tick its removal.

**Preview** shows each change against the current value, how many existing scores the `me.yaml` change would mark stale
(they are scored again, which uses AI), and a retention notice. Untick anything you do not want; the counts follow.
**Apply** writes only what is ticked, through the same saves as the profile page. If either file or the stale count
changed since the preview, nothing is written and a new preview is shown. Each file reports its own result, and applying
the same profile again changes nothing. After you edit the profile, the page notes that it changed since the last apply.

What is applied stays: earlier versions of `me.yaml` and `stories.yaml` are kept in the database's profile history and in
database backups. **Delete all career data** does not remove them; delete or roll back on the profile page if needed.

While the career profile is on, the extraction entries of the experience library move here: the library card links to
this page instead.

## Delete and backups

**Clear history** removes only `career/history/`. **Delete all career data** removes the entire career directory,
including the contact file and drafts, and cancels running or queued extraction requests (an already-started provider call may continue). Both require a second confirmation and an enabled feature. To delete while it is off,
turn it on first; turning it off alone never deletes anything.

Deletion does not affect existing backups, `before-restore` directories or content already sent to an AI provider.
The career directory is included in the configuration archive. Scheduled archives follow `config_archive` and daily /
weekly retention; manual archives are kept until you remove them; system archives have their own retention. Restoring
an older backup can bring a profile deleted later back. To remove all retained copies, also remove the relevant backup
archives and retained profile directories yourself. Content already applied to matching stays in `me.yaml`,
`stories.yaml`, the profile history and database backups (see [Apply to matching](#apply-to-matching)). See [Backup and restore](backup-restore.md) and [Privacy](privacy.md).

A save request can carry at most 1 MB. A very large profile can reach that before the entry and wording limits; the
save then fails with an error and your edits stay in the form. Shorten the content and save again.

## Résumé documents

From `/career`, open **Résumé documents** and create a document from your saved, nonempty profile.
Each document is an independent copy: later profile edits do not change it, and a banner tells you
when the profile has changed.

Open a document to edit and reorder entries, include or exclude entries and bullets, or add handwritten
entries. Edited text and sources deleted from the profile are marked. Add a cover letter in the Letter tab.
Use the live preview to check your changes. The preview is rendered on your machine; nothing is sent to AI.
Contact details are read only for the preview and are never copied into document files. You can hide
individual contact fields for each document.

Upload a shared photo or signature as PNG or JPEG; the size limit is `career.yaml: document.image_max_bytes`.
Images are shared across documents. In the layout menu, choose the theme, accent, page budget, paper,
density, colours, language, filename, section order and signature. **Save as my defaults** applies the
layout to future documents. Use history to view and restore earlier versions; save pending edits first.
Delete a document from the list after confirmation; this also removes its history.

### Page count, checks and PDF export

Page counts and PDF export need the optional PDF service: set `COMPOSE_PROFILES=career-pdf` and deploy again (see
[Optional résumé PDF service](deploy.md#optional-résumé-pdf-service)). Without it the page count shows as unknown and
the editor shows the start hint; editing and preview keep working.

With the service running, the page count next to the preview refreshes a few seconds after you stop typing
(`preview.page_count_debounce_ms`) and is highlighted when it exceeds the page budget. **Export résumé PDF** and,
when the letter has text, **Export letter PDF** save the document first and download the PDF; the file name comes from
the layout's filename, and résumé and letter get different names. The app keeps no copy of the PDF.

Checks run while you edit: placeholders left in the text, length and wording limits, and after a page count or export
also the page budget and reading order. Placeholders are shown next to the export buttons. Characters that the bundled
fonts do not cover (for example Chinese) are listed before export. Checks and font hints never block an export. The
limits and word lists are `career.yaml: check.limits` and `check.lexicon`; words you add keep the shipped lists.

To fit a document to one job with AI proposals you review one by one, see [Résumé tailoring](resume-tailoring.md).
