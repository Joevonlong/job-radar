# Reason sources

[English](score-evidence.md) | [中文](score-evidence.zh.md)

The job page lists the AI's **fit reasons** and **gaps** next to the score. With reason sources on, each of them says
where it comes from:

| Marker | Meaning |
|---|---|
| **JD** (solid) | The posting says it. Click the marker to see the posting's own words; **View in the original** jumps to them in the job description, where they are underlined with a thin solid line. |
| **Inferred** (outlined) | The AI concluded it from the posting and your profile; the posting does not say it in so many words. |
| **Not stated** (dashed, gaps only) | The posting does not mention it at all, for example no salary. |

The score itself does not change: the sources only show how much of the reasoning you can check in the posting.

## Turning it on

**Settings → AI → Reason sources**, or in `data/config/ai.yaml`:

```yaml
scoring:
  evidence:
    enabled: true        # default false
    quote_max_chars: 150 # longest quote the AI may give, 20 to 500
```

Turning it on or off, and changing `quote_max_chars`, marks no score stale and re-scores nothing: the prompt version
stays the same. The setting applies to jobs scored from then on.

## Why it is off by default

Every scoring call answers a little more: a source for each reason and a short quote for each "JD" reason, roughly
"number of reasons × quote length" more output tokens. On a subscription with a tight quota that adds up. To see what it
costs you, compare the **median output tokens of the `score` calls** on `/sources/ai-usage` (task: score) for a few days
before and after you turn it on. The calls are still recorded as `score`.

## How a quote is checked

The AI is asked for the shortest word-for-word passage of the posting that proves the reason, in the posting's own
language (never translated, even when the reasons are written in Chinese). Job Radar then looks the quote up in the
stored job description (spaces, line breaks and list bullets do not count):

- Found: it is stored as the posting spells it, with its position, and the reason shows **JD**.
- Not found (the AI paraphrased or translated it), or it falls on text the AI trap check flagged (hidden text or an
  instruction aimed at an AI, see [ai-traps.md](ai-traps.md)): the reason is kept and shows **Inferred**. The scoring
  run logs how many reasons were downgraded this way.

A quote is shown as plain text, never as HTML, and only shown: nothing in it is acted on.

## Old scores

Scores made before reason sources were on have no sources. Their reasons are shown as before, and while the setting is
on the panel adds a line saying the score predates sources. There is no command to add sources to old scores: that would
cost a full scoring call per job. A score gets sources the next time it is scored again anyway (after a profile, criteria
or prompt change).

A reason the AI gave without a source (an answer in the old format) is shown without a marker.

## Where it is stored

`scores.reason_evidence` (JSON, one source per reason in the order of `fit_reasons` and `gaps`). The two text columns
are written exactly as before, so exports, Telegram and older versions read the reasons unchanged. An AI worker that
starts before the database migration ran keeps scoring and stores the reasons without sources until it has run.

## Before rolling back to an older version

Versions before reason sources refuse an `ai.yaml` with `scoring.evidence`. **Delete the `scoring.evidence` key before
you roll back.** The database column can stay: older versions do not read it.
