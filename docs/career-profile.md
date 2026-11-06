# Career profile

[中文](career-profile.zh.md)

The optional career profile is a local library of career facts and alternative wordings. You can edit it manually or extract a reviewable draft from your own text. The profile editor does not export résumés. It is independent of the
application writer and does not change matching, scores or the experience library on **My profile**.

## Turn it on

Open **Settings → Workflow → Career profile**, enable it and save. A card below the matching profile on **My profile**
links to `/career`. Before the first write, the card says the profile has not been created. There is no sidebar entry. Advanced settings also lists `career.yaml`.

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

## Delete and backups

**Clear history** removes only `career/history/`. **Delete all career data** removes the entire career directory,
including the contact file and drafts, and cancels running or queued extraction requests (an already-started provider call may continue). Both require a second confirmation and an enabled feature. To delete while it is off,
turn it on first; turning it off alone never deletes anything.

Deletion does not affect existing backups, `before-restore` directories or content already sent to an AI provider.
The career directory is included in the configuration archive. Scheduled archives follow `config_archive` and daily /
weekly retention; manual archives are kept until you remove them; system archives have their own retention. Restoring
an older backup can bring a profile deleted later back. To remove all retained copies, also remove the relevant backup
archives and retained profile directories yourself. See [Backup and restore](backup-restore.md) and [Privacy](privacy.md).

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
Delete a document from the list after confirmation; this also removes its history. Page count and PDF
export are not available yet.
