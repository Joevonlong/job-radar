# Languages

[English](languages.md) | [中文](languages.zh.md)

Job Radar keeps every user-visible text in `messages/<id>.json`, one file per interface language (English and Chinese
ship with it). Which language is used where is set in `language.yaml` (Settings → Interface → Languages).

## `language.yaml`

| Key | Default | Meaning |
|---|---|---|
| `ui.default_locale` | `en` | Interface language of a browser that never picked one. The language button in the top bar remembers a choice per browser (cookie). Must be one of the messages files. |
| `ai.output` | `en` | The language of everything the AI writes: fit reasons, gaps, the one-line summary, the job breakdown, suggestion reasons. Any language code (`en`, `zh`, `de`, `fr`, `pt-BR` …). |
| `ai.summary_also` | `[]` | The one-line summary is also written in these languages, so another interface language still shows one. |
| `translation.target` | `en` | Job ads are translated into this language. Ads already written in it get no translation tab and no translate button, and the automatic translation skips them. |
| `notify.locale` | `null` | Language of Telegram messages, buttons and alerts; `null` = `ui.default_locale`. |
| `cli.locale` | `null` | Language of `pnpm run doctor`, `pnpm sources:list` and `pnpm deliveries:show`; `null` = `ui.default_locale`. These commands also take `--lang en|zh`. |

Language codes are BCP 47 tags (`en`, `zh`, `de`, `pt-BR`, `zh-Hant`); an invalid one is refused when saving and by
`pnpm config:check`.

An install from before languages were configurable gets a `language.yaml` written on its first start with what it did
until then: Chinese interface, AI texts, Telegram and command line, English one-line summaries next to the Chinese
ones, translations into Chinese. A new install gets the English defaults above.

### What changes when you change a language

- **Interface**: at the next page load (the web app reads `language.yaml` fresh). A browser that picked a language with
  the button keeps it.
- **AI output**: new results are written in the new language. Earlier scores, breakdowns and suggestions are not
  rewritten (that would cost an AI call per job): they keep their language, and the job page marks text that is not in
  the interface language with a small language tag (for example `中文`) and the right `lang` attribute. Nothing is
  translated automatically.
- **Translation target**: translations are stored per language, so switching back shows the earlier ones again.
- **Telegram / command line**: the next message or run.

The one-line summary shown is the one in the interface language, else in the AI output language, else English, else
any language there is; a summary in another language than the interface carries a language tag.

## Command-line output

- **User commands** follow `cli.locale` (or `--lang`): `pnpm run doctor`, `pnpm sources:list`, `pnpm traps:scan`, and the
  Telegram test message of `pnpm telegram:test` (Telegram language). Their `--json` output carries codes only (ids,
  statuses, reason keys); the doctor's JSON also says which `locale` its texts are in.
- **Developer and maintenance commands** (`config:check`, `*:migrate`, `db:*`, `smoke:*`, `score:*`, `simhash:*`,
  `auth:linkedin`, the e2e tools, logs) are in English.

## Adding an interface language

1. Copy `messages/en.json` to `messages/<id>.json` (for example `fr.json`; the file name is the language code).
2. Fill in `meta`: `name` (the language's own name, shown in the language menu), `intl` (the tag for dates and
   numbers, `fr-FR`), `promptName` (how a prompt names the language to an AI, `French`), `wide` (`true` for CJK
   scripts). Translate `format` (relative times, duration units, salary words) and as many other keys as you like:
   a key that is missing shows the English text.
3. Run `pnpm i18n:catalog` (it also runs before `pnpm dev`, `pnpm build` and `pnpm build:runner`) and commit the
   regenerated `src/i18n/catalog.generated.ts` and `src/i18n/messages.generated.ts`. `pnpm i18n:check` (part of
   `scripts/validate.sh` and CI) fails when a messages file is invalid or the generated files are stale.

No hand-written code changes. With more than two languages the language button becomes a menu that lists every
language by its own name. Rules the check enforces: English and Chinese have every key; other languages have no key
English lacks; every message uses the same ICU placeholders as the English one; `meta` is valid.

## For contributors

- User-visible text goes into `messages/*.json`, never into components, Telegram messages, doctor checks or CLI
  output meant for users. `tests/i18n/no-hardcoded-cjk.test.ts` scans every string literal and JSX text of `src/` and
  `scripts/` for Han characters (comments are fine); the allow-list holds only demo data and migration templates.
- Outside React, use `translatorFor(locale, namespace)` or `getTranslator(namespace, "notify" | "cli")` from
  `src/lib/i18n/node.ts`; Telegram formatting gets a `NotifyText`, doctor checks use `ctx.t`.
- Format numbers, times and salaries only through `src/lib/format/*` with an explicit locale.
