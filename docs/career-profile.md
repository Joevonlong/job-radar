# Career profile

[中文](career-profile.zh.md)

The optional career profile is a local library of career facts and alternative wordings. This version supports manual
editing only: it makes no AI requests and does not import, generate or export résumés. It is independent of the
application writer and does not change matching, scores or the experience library on **My profile**.

## Turn it on

Open **Settings → Workflow → Career profile**, enable it and save. A card below the matching profile on **My profile**
links to `/career`. Before the first write, the card says the profile has not been created. There is no sidebar entry. Advanced settings also lists `career.yaml`.

Turning it off keeps all saved files and history. Disabled pages and actions do not read or clean the career directory.
A missing or invalid career config closes the feature, including after it was previously enabled. If the profile itself
is unreadable, its card and editor show a readable error message; the rest of My profile continues to work.

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

Files written by the app have mode `0600`. The directory is created on the first save. Contact details have a separate
save button and stale-file check. They are overwritten without history: old contact values are never copied into career
history. The optional contact photo field is reserved; this editor does not use images.

Contact details are stored only on this machine and never sent to AI. A city identical to your contact location may
still occur in an experience's location and be sent as part of that content by future AI features. This manual editor
sends no career content to AI, Telegram or MCP and writes no database profile snapshots. Profile text can itself contain
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
including the contact file. Both require a second confirmation and an enabled feature. To delete while it is off,
turn it on first; turning it off alone never deletes anything.

Deletion does not affect existing backups, `before-restore` directories or content already sent to an AI provider.
The career directory is included in the configuration archive. Scheduled archives follow `config_archive` and daily /
weekly retention; manual archives are kept until you remove them; system archives have their own retention. Restoring
an older backup can bring a profile deleted later back. To remove all retained copies, also remove the relevant backup
archives and retained profile directories yourself. See [Backup and restore](backup-restore.md) and [Privacy](privacy.md).

A save request can carry at most 1 MB. A very large profile can reach that before the entry and wording limits; the
save then fails with an error and your edits stay in the form. Shorten the content and save again.
