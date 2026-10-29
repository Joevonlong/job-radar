# 语言

[English](languages.md) | [中文](languages.zh.md)

Job Radar 的所有用户可见文字都在 `messages/<id>.json` 里，一个文件就是一种界面语言（自带英文和中文）。
哪里用哪种语言由 `language.yaml` 决定（设置 → 界面 → 语言）。

## `language.yaml`

| 键 | 默认值 | 含义 |
|---|---|---|
| `ui.default_locale` | `en` | 浏览器没选过语言时的界面语言。顶栏的语言按钮会按浏览器记住选择（cookie）。必须是 messages 里有的语言。 |
| `ai.output` | `en` | AI 写的所有文字的语言：匹配理由、差距、一句话摘要、JD 拆解、兴趣建议理由。可以是任何语言代码（`en`、`zh`、`de`、`fr`、`pt-BR`……）。 |
| `ai.summary_also` | `[]` | 一句话摘要另外再写哪些语言，切换界面语言时也有摘要可看。 |
| `translation.target` | `en` | JD 翻译成什么语言。本来就是这种语言的岗位没有翻译标签页和翻译按钮，自动翻译也会跳过。 |
| `notify.locale` | `null` | Telegram 消息、按钮和告警的语言；`null` = 用 `ui.default_locale`。 |
| `cli.locale` | `null` | `pnpm run doctor`、`pnpm sources:list` 和 `pnpm deliveries:show` 的语言；`null` = 用 `ui.default_locale`。这些命令也接受 `--lang en|zh`。 |

语言代码按 BCP 47（`en`、`zh`、`de`、`pt-BR`、`zh-Hant`）；写错了保存时会被拒绝，`pnpm config:check` 也会报。

语言可配置之前就装好的实例，第一次启动时会写入一份保持原来行为的 `language.yaml`：界面、AI 文字、Telegram、
命令行都是中文，一句话摘要另附英文，JD 翻译成中文。全新安装用上面的英文默认值。

### 改了语言会怎样

- **界面**：下次打开页面就生效（网页每次都重新读 `language.yaml`）。用按钮选过语言的浏览器保持自己的选择。
- **AI 输出**：新结果用新语言写。旧的打分、拆解、建议不会重写（那样每个岗位都要再调一次 AI）：它们保持原来的语言，
  详情页给不是界面语言的文字加一个小语言标记（比如 `English`）和正确的 `lang` 属性，不做自动翻译。
- **翻译目标**：翻译按语言分别保存，切回原来的语言时旧译文还在。
- **Telegram / 命令行**：下一条消息、下一次运行。

显示的一句话摘要：优先界面语言，其次 AI 输出语言，再次英文，都没有就用现有的任意一种；不是界面语言的摘要带语言标记。

## 命令行输出

- **用户命令**跟随 `cli.locale`（或 `--lang`）：`pnpm run doctor`、`pnpm sources:list`、`pnpm traps:scan`，以及
  `pnpm telegram:test` 发出的测试消息（用 Telegram 语言）。它们的 `--json` 输出只放代码（id、状态、原因键）；doctor 的
  JSON 另外写明文字用的是哪种 `locale`。
- **开发和维护命令**（`config:check`、`*:migrate`、`db:*`、`smoke:*`、`score:*`、`simhash:*`、`auth:linkedin`、e2e
  工具、日志）统一英文。

## 加一种界面语言

1. 把 `messages/en.json` 复制成 `messages/<id>.json`（比如 `fr.json`；文件名就是语言代码）。
2. 填好 `meta`：`name`（这种语言自己的名字，显示在语言菜单里）、`intl`（日期和数字用的标签，`fr-FR`）、`promptName`
   （prompt 里怎么向 AI 称呼这种语言，`French`）、`wide`（CJK 文字填 `true`）。翻译 `format`（相对时间、时长单位、
   薪资用词），其他键翻多少都行：缺的键显示英文。
3. 运行 `pnpm i18n:catalog`（`pnpm dev`、`pnpm build`、`pnpm build:runner` 之前也会自动跑），把重新生成的
   `src/i18n/catalog.generated.ts` 和 `src/i18n/messages.generated.ts` 一起提交。`pnpm i18n:check`（在
   `scripts/validate.sh` 和 CI 里）会在 messages 文件不合法或生成文件过期时失败。

不需要改手写代码。超过两种语言时，语言按钮会变成菜单，每种语言用它自己的名字列出。检查的规则：英文和中文必须键完整；
其他语言不能有英文没有的键；每条消息的 ICU 占位符和英文一致；`meta` 合法。

## 给贡献者

- 用户可见的文字写进 `messages/*.json`，不要写在组件、Telegram 消息、doctor 检查项或给用户看的命令行输出里。
  `tests/i18n/no-hardcoded-cjk.test.ts` 会扫描 `src/` 和 `scripts/` 里所有字符串字面量和 JSX 文本中的汉字（注释不算），
  允许清单只有演示数据和迁移模板。
- React 以外用 `src/lib/i18n/node.ts` 的 `translatorFor(locale, namespace)` 或 `getTranslator(namespace, "notify" | "cli")`；
  Telegram 的格式化函数接收 `NotifyText`，doctor 检查项用 `ctx.t`。
- 数字、时间、薪资只用 `src/lib/format/*` 格式化，并且显式传入语言。
