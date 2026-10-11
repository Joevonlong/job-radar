# Using Job Radar in an organisation

[English](commercial-use.md) | [中文](commercial-use.zh.md)

Job Radar is a single-user tool licensed under the [AGPL-3.0](../LICENSE). This page answers the questions a company, a
recruiting team or a career coach usually has. It is an engineering explanation, **not legal advice**; ask your own lawyer
if the answer matters.

**Can my company run it internally, without changes?** Yes. Running an unmodified copy for yourself, or for staff inside
your organisation, brings no extra obligation beyond keeping the licence and copyright notices ([NOTICE](../NOTICE)).

**What if we change the code?** If other people use your modified version over a network (including employees,
customers or clients), the AGPL (section 13) requires you to offer those users the complete source of your version. The
sidebar shows the version and a "Source code" link; in a fork, change `repository.url` in `package.json` so that it points to
your fork. Changes you only use yourself on your own machine need no publication.

**Can several people share one instance?** No, it is not designed for that. There are no accounts and no authentication
between users: whoever can open the web page sees and changes the one profile, every application and every note. Run **one
instance per person** (a separate checkout and a separate data directory, see the operations guides) and keep each instance
reachable only by its owner.

**Can we offer it as a hosted service?** The AGPL allows it if you provide the source of your version to your users, but the
architecture gives no isolation between users' data, and the points below (scraping, AI provider terms) become your
responsibility. Plan for one isolated instance per client.

**Scraping other sites.** Some channels read pages of job sites whose terms forbid automated access (see [Scraping in
sources.md](sources.md#scraping)). Those channels are off by default. A company doing this at scale, from a company
network, carries more risk than a person doing it once a day from home. Prefer official APIs, the company career boards and
your own job-alert emails.

**AI subscriptions.** The `codex` and `claude` command-line tools are used with the personal login of whoever installed
them. Consumer subscriptions (ChatGPT, Claude Pro or Max) are personal licences; using them to serve several people or inside
a company deployment may not be covered by their terms. For organisational use, use API keys under a commercial agreement.
Check each provider's current terms, and see [privacy.md](privacy.md) for what is sent to them.

**Trademarks.** Job Radar is not affiliated with LinkedIn, Indeed, StepStone, XING, Google, Anthropic, OpenAI, Telegram or
any other service it can talk to; those names belong to their owners.

**No warranty.** The software is provided as is. See the licence for the exact terms.
