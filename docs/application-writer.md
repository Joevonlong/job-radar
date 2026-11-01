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

## Writing answers (`/jobs/<id>/apply`)

**Write answers** on a job's page opens the workbench for that job (the button shows how many questions have a final
version, e.g. `1/3`). While `writer.yaml: enabled` is `false` the button leads to Settings → Workflow, and the workbench
only says how to switch the writer on; answers saved earlier are still shown.

The workbench has three columns (below 1024 px one at a time, switched at the top):

1. **Material** of the selected question. Every tick is saved on the question at once; nothing is sent before you press
   **Write**.
   - **JD points** from the job's breakdown ([breakdown.md](breakdown.md)), grouped into must have, nice to have and
     the rest; a new question starts with the must-haves ticked. Without a breakdown the column offers to make one,
     or tick **Also send an excerpt of the JD text** instead (the JD after the AI-trap cleaning, cut at
     `jd_max_chars`). When the breakdown or a story changed and a ticked item no longer exists, the column says so
     and **Remove** drops it; it is never sent.
   - **Profile**: your `me.yaml` summary, skills with years and languages. Not your name, contact details, home city
     or visa status.
   - **Stories** of your experience library; a new question starts with the `stories.preselect_count` stories whose
     skills overlap most with the job's.
   - **What to stress this time**: a free note, at most `emphasis_max_chars`.
2. **Questions**: paste a question from the application form, or add a cover letter (one long question). Each has
   its own text, tone, target length (words or characters) and answer language (by default the JD's language, else
   the AI output language of `language.yaml`). At most `questions.max_per_job` per job; deleting a question deletes
   its versions.
3. **Answer**: the box above the button lists exactly what will be sent and to which providers (the `write` task's
   order in `ai.yaml`). **Write** asks for 2–3 versions in different styles (`variants`); writing runs on the
   ai-worker on your Mac like the other AI buttons, and the page waits for it. Every draft adds versions; the oldest
   go once a question has more than `questions.max_versions_per_question` (the final version is always kept).

### The evidence of every sentence

The AI must give, for every sentence, what it rests on: a quote from the JD, your profile, a named story, your
emphasis note or your draft. Job Radar then checks each sentence in code, without another AI call:

| Mark | Meaning |
|---|---|
| Has evidence (no underline) | Every figure and name in the sentence is in the quotes, and the quotes were found in the material. |
| Partly backed (amber) | Evidence was found, but a figure or a name in the sentence is not in it; the detail lists them. |
| No evidence (red) | No quote was found in the material the sentence may rest on (a sentence about you cannot rest on the JD alone). |
| Framing (dotted) | A linking sentence without facts. |
| Written by you (grey) | A sentence you wrote or changed; not checked. |

Click a sentence for its quotes, where each was found and what is missing. A sentence that says "I" or "my" is always
checked as one about you, whatever the AI called it. Names the check cannot find in the evidence, the JD or the
company are marked **Check:** — that is a hint for you to look, not a guarantee: the check only knows what looks like
a name (quoted words, words with digits or inner capitals, capitalised words inside a sentence; `evidence.names`), so
it can miss one and can mark a harmless word. Figures are compared as digits ("40 %", "40 Prozent" and "40%" are
one figure; "€85k" and "85,000 €" one amount); a figure written as words ("forty percent") is not recognised. **"Has evidence" means a quote was found, not that the sentence is
true.** Read every sentence before you send it.

**Copy** copies the plain text. **Edit** saves your changes as a new version: unchanged sentences keep their check,
changed ones become "written by you". **Mark as final** marks the version you sent; the job page counts final
versions.

### What is sent, and what stays

Only what the disclosure box lists is sent, only when you press **Write**, and only to the providers of the `write`
task. There is no web search. The request carries the material from the database to the ai-worker; once it is done,
fails or expires (`timeout_seconds`, queued or running), the material is removed from the request and only the
question id and a hash of the material remain. The versions are stored in your database with their checks.

## Settings (`writer.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch of the AI writing features. While it is `false`, nothing of your library is sent to an AI provider. Also in Settings → Workflow. |
| `timeout_seconds` | `180` | Longest wait of one writing request, queued or running; an older one fails as expired and its material is cleared. Also in Settings → Workflow. |
| `stories.max_items` | `60` | Most stories in the library |
| `stories.title_max_chars` | `120` | Longest title; also the longest single figure, skill or tag |
| `stories.text_max_chars` | `1500` | Longest "what you did" and "result" |
| `stories.preselect_count` | `4` | How many stories a new application question starts with selected |
| `questions.max_per_job` | `12` | Most questions per job |
| `questions.text_max_chars` | `1000` | Longest question text |
| `questions.max_versions_per_question` | `20` | Most versions of one question besides the final one |
| `questions.kinds.<kind>` | question: 150 words, 3 versions; letter: 350 words, 2 versions | Default length and number of versions per draft |
| `variants` | safe, distinctive, short | The styles of the versions of one draft, in order |
| `tones` | neutral, warm, confident, formal | Tones a question can ask for (the first is the default) |
| `emphasis_max_chars` | `800` | Longest "what to stress this time" note |
| `jd_max_chars` | `6000` | Longest JD excerpt |
| `evidence.quote_max_chars` | `160` | Longest quote the AI may give |
| `evidence.first_person` | en / de / zh words | Words that make a sentence one about you |
| `evidence.names` | quoted, mixed tokens, capitalised words (German: only two or more in a row) | What the check treats as a name |

Which AI writes is the `write` task in `ai.yaml` (order, model, and for the API providers `max_output_tokens` /
`api_timeout_seconds` of their own: cover letters with several versions need more than the global output cap; see
[ai-providers.md](ai-providers.md)). An answer cut off at that cap fails with a message naming the setting.

The story limits are checked when you save on `/me`; a save over them is refused field by field and the file is left as it
was. The file format itself allows more, so a library written under larger limits still loads.
