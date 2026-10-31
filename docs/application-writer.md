# Application writer

English | [中文](application-writer.zh.md)

Application forms ask questions such as "Why do you want to join us?", and many ask for a cover letter. The application
writer is built around one rule: every sentence about you should rest on something you wrote yourself. That material is
your **experience library** on `/me`.

## Experience library (`stories.yaml`)

The **My experience** card on `/me` holds your projects and achievements, one per story:

| Field | What to write |
|---|---|
| Title | A short name ("Moved billing to the new platform") |
| What you did | Your part, in your own words |
| Result | What came of it (optional) |
| Figures | One per entry, as you would state them ("monthly close from 5 to 3 days") |
| Skills | Technologies and skills the story shows |
| When | Free text ("2021–2023") |
| Language | The code of the language you wrote it in (`en`, `de`, `zh`, …), optional |
| Tags | Your own labels, optional |

- **Add, edit, delete, reorder** on the card, then **Save**: like the other `/me` forms, nothing is written before you
  save, and **Reset** brings back the saved version.
- **Ids.** A new story gets an id made from its title when it is first saved (`moved-billing-to-the-new-platform`; a
  title without Latin letters gives `story`, `story-2`, …). The id never changes after that, even when you rename the
  story; answers will refer to stories by it.
- **History and rollback.** Every save leaves a snapshot; the **History** panel on `/me` has a **My experience** tab
  with the changes of each version and **Roll back**. The library is not read by scoring: saving it or rolling it back
  never makes a score stale and never starts a re-score.
- **Edited elsewhere.** When the file changed after you opened `/me` (another tab, or by hand), the save is refused and
  the card reloads with the saved version.
- **A broken file.** When `data/profile/stories.yaml` has a syntax or format error, the card is replaced by the error,
  naming the line (`pnpm config:check` shows it too). Roll back from the history or fix the file by hand.
- **Contact details.** Stories are written to be sent to an AI provider once the writer is switched on. When a story
  seems to contain an email address or a phone number, the card says so before you save (it does not stop the save).
  Leave out your name, contact details and ID numbers.

The file is `data/profile/stories.yaml` (template: `config/profile.example/stories.yaml`), so it is in the daily
configuration archive with the rest of `data/profile/` ([backup-restore.md](backup-restore.md)).

## Settings (`writer.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch of the AI writing features. While it is `false`, nothing of your library is sent to an AI provider. |
| `stories.max_items` | `60` | Most stories in the library |
| `stories.title_max_chars` | `120` | Longest title; also the longest single figure, skill or tag |
| `stories.text_max_chars` | `1500` | Longest "what you did" and "result" |
| `stories.preselect_count` | `4` | How many stories a new application question starts with selected |

The limits are checked when you save on `/me`; a save over them is refused field by field and the file is left as it
was. The file format itself allows more, so a library written under larger limits still loads.
