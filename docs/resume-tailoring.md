# Résumé tailoring

[English](resume-tailoring.md) | [中文](resume-tailoring.zh.md)

Tailoring asks an AI provider how one [résumé document](career-profile.md#résumé-documents) should change for one job.
The AI only proposes; nothing changes in the document until you accept a proposal. It needs the career profile switched
on (`career.yaml: enabled`, **Settings → Workflow**); while it is off, `/career/tailor` only says so.

## The flow

1. Open **Tailor to a job** on `/career/documents` or in a document, or `/career/tailor?job=<id>`. Search for the job
   by title or company. If the job already has a tailored document you can open it or start a new one.
2. Add separate requirements for this application, for example "Mention the on-call work". They are saved in the
   document. `career.yaml: tailor.max_requirements` and `tailor.requirement_max_chars` limit their number and length.
   Your default emphasis and tone are shown read-only; change them in the document's Layout tab.
3. Tick **Also suggest a cover letter** if you want letter proposals.
4. Press **Preview what will be sent**. The preview lists every block and the JD exactly as they will leave your
   machine. Only then can you press **Confirm and generate**. If what would be sent changes between the preview and the
   start, the request is refused and the updated preview is shown for another confirmation.
5. The page shows the request as queued, running, failed (with the reason) or done. One document has at most one
   running request; another request with different content waits until it ends.
6. Review the proposals: first include, exclude and order, then wording. Each proposal shows the change as a word diff,
   the quotes from your profile it relies on, the AI's reason and any content your profile does not have. Accept or
   reject each one. A proposal whose target was deleted can only be rejected. If the document was changed elsewhere
   after generation, a note asks you to check each proposal against the current text.
7. Generating again replaces proposals you have not reviewed; the preview warns you first.

The proposals are kept beside the document (`career/documents/<id>.proposals.yaml`) until you review them or delete the
document. Unreviewed proposals are also reachable from the document editor.

## What is sent

To the `career_tailor` provider in `ai.yaml`, in up to three calls (selection, wording, cover letter):

- the document's included and excluded entries and texts, its headline, summary and letter;
- the facts of your profile, used as the evidence the AI must quote;
- your default emphasis and tone, the separate requirements, the job title and company;
- the JD after cleaning, cut to `tailor.jd_max_chars` (the beginning and the end are kept, `tailor.jd_head_share` sets
  the share of the beginning). The preview says when the JD was cut.

Contact details, links, photos and signatures are never sent. Contact values detected in other text are replaced by
placeholders, but detection can miss details: read the preview. See [Privacy](privacy.md#résumé-tailoring).

## The marks

Each text in the document editor carries a mark. The marks are only in the editor: the preview and an export show the
plain text, and a mark never blocks an export.

| Mark | Meaning |
|---|---|
| (no mark) | Taken unchanged from your profile |
| Rewritten | The AI reworded profile content and its quotes cover the new words |
| Not in your profile | The text says something the quotes do not support: a number, a skill, a duty or another fact. Each item is listed with its kind and **Only in the job description** when the word appears in the JD but not in your profile. Confirm it if it is true, or reject it |
| Confirmed | You confirmed every flagged item |
| Written by you | You edited the text yourself |

A text translated from a profile wording in another language cannot be checked word by word. Such texts are listed
together at the top with the words only the JD has; one **Confirm translation** confirms that the translation did not
change any fact.

### How reliable the check is

The check is a word-level heuristic, not an understanding of meaning. It misses claims that reuse your own words in a
new sense, and it flags rewordings that use new words for the same fact. A rewritten duty is accepted when the quotes
cover at least `tailor.duty_min_coverage` of its content words. The shipped value 0.70 is a starting value: on a set of
fictional sample texts it missed 0% of unsupported claims and raised 0% false alarms in English, and missed 0% with 8%
false alarms in German. These rates come from fictional samples, not real model output, and the threshold will be
recalibrated once real output has been measured. Read every proposal yourself.

## Shortening

**Suggest shortening** asks only for removals and shorter wording, for a document over its page budget. It is enabled
only when the page count is known and exceeds the budget; while the page count is unknown, the button is disabled and
says so.

## Cover letter: tailoring or the application writer

The [application writer](application-writer.md) writes answers and cover letters as free text from your experience
library, with a per-sentence evidence check. Tailoring changes this formatted résumé document, including its letter
fields, by proposals you accept one by one. Use the writer for application questions; use tailoring for the résumé and
letter you export.

## Saving back to the profile

**Save back to profile** on a rewritten text adds it as another wording of the profile text it came from. A text without a
source (an added bullet or a letter field) asks which profile entry should receive it. Items marked **Not in your
profile** must be confirmed or removed first; the button otherwise says so. Saving back changes your profile and its
history, not other documents.

## Settings

All under `tailor` in `career.yaml`, see [Configuration](configuration.md#career-profile-careeryaml):
`max_requirements`, `requirement_max_chars`, `duty_min_coverage`, `max_proposals`, `jd_max_chars`, `jd_head_share`, and
the word lists for the check (`first_person`, `names`, `stopwords`). The time limits are the career request limits
`timeout_seconds`, `expiry_grace_seconds` and `queue_timeout_seconds`.
