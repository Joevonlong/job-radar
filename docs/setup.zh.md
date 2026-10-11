# 首次设置

[English](setup.md) | [中文](setup.zh.md)

新安装会先打开设置向导。`docker compose up -d` 之后打开 <http://127.0.0.1:3000>：设置完成之前，打开任何页面都会进入
`/setup`。没有浏览器的机器上，`pnpm run setup` 在终端里问同样的问题。两者写的是同一批文件：没有另外的存储，之后每一步都能在
平常的页面上再改。

## 八个步骤

| 步骤 | 选什么 | 写到哪里 |
|---|---|---|
| 语言 | 界面语言（按浏览器预选）、AI 文字的语言、岗位翻译成的语言 | `language.yaml` 的 `ui.default_locale`、`ai.output`、`translation.target`；这个浏览器的语言 cookie |
| 市场 | 市场包、本国、基准货币、本地语言、城市（列出包里的城市，也可以自己输入）、远程范围、时区（按浏览器预选）。换一个国家时，只要你还没自己改过，货币和城市会换成这个国家的货币和主要城市；画像步骤的所在城市也从这里预填 | `preferences.yaml` 的 `market`、`locations`、`remote_scope`；`search.yaml` 的 `locations`、`remote_scope`；`schedule.yaml` 的 `timezone` |
| 画像 | 给 AI 的简介、技能和年限、语言和 CEFR 等级（会加上市场本地语言一行）、工作年限、签证、所在城市 | `me.yaml`（保留画像历史快照） |
| 目标 | 岗位名、级别、工作方式、薪资底线（市场货币）、合同类型、要排除的公司 / 关键词 / 学生岗 | `preferences.yaml`；`search.yaml` 的 `keyword_groups`（见下） |
| 来源 | 你所在市场的渠道（市场包自己的招聘网站带"本地"标记；抓取类和账号类渠道永远不预选，需要确认，见下）、要添加的公司招聘页 | `sources.yaml` |
| AI | 订阅 CLI 和 API 服务商：开关、顺序、默认模型和强模型，每个服务商可以测试 | `ai.yaml`（按 `models.yaml` 核对） |
| Telegram（可选） | 推送开关（默认关，需要你打开）、消息语言、测试消息 | `notify.yaml` 的 `telegram.enabled`；`language.yaml` 的 `notify.locale` |
| 检查 | 每一步的结果、就绪清单（画像、渠道、AI、runner 和 ai-worker）、"立即跑第一轮"、完成 | `setup.yaml` |

"保存并继续"立即写入这一步的文件（文件里的注释会保留），并把这一步标为完成；文件不接受的值显示在对应字段旁边，什么都不写。
"跳过"只把这一步标为跳过，不写任何配置；Telegram 例外：跳过时如果没有设置 `TELEGRAM_BOT_TOKEN` 或 `TELEGRAM_CHAT_ID`，会把 `telegram.enabled` 关掉，推送就不会每一轮都报错。在 `/me` 改了地点，页面会提示把它们同步到搜索城市（`search.yaml` 的 `locations`，是单独的一份清单）。步骤条上任何一步都能点回去，显示的是文件里现在的值。

**搜索关键词。** `search.yaml` 还是随产品发布的示例组时，整体换成一个组 `targets`，内容是你的岗位名。你自己改过的组保留，
只新增或替换 `targets`。目标这一步在保存前先显示结果。

**抓取类渠道需要确认。** LinkedIn 游客搜索、Indeed、StepStone、XING 和 LinkedIn 登录会话读取的页面，其服务条款可能禁止自动访问。
它们在新安装里默认不勾选，每一行都有简短的风险说明；只要勾选其中任何一个，就必须再勾上"我已阅读上面的说明，自行承担使用这些渠道的责任"才能保存这一步（服务端也会拒绝未确认的保存）。
已经开启且之前确认过的渠道不会再问。详情和渠道清单见 [sources.zh.md](sources.zh.md#抓取)。

**密钥和 token 不在这里填写。** 向导只显示变量名（`TELEGRAM_BOT_TOKEN`、`JSEARCH_API_KEY`、`ANTHROPIC_API_KEY` ……）和是否已设置。
把它们写进 `.env`，再用 `docker compose up -d` 重启（AI 的 key 还要重启 ai-worker）。向导也不会替你安装 ai-worker，不会替你登录
`claude` / `codex` 或 LinkedIn：见 [host-setup.zh.md](host-setup.zh.md)、[ai-providers.zh.md](ai-providers.zh.md) 和
[linkedin-session.zh.md](linkedin-session.zh.md)。

不在向导里（检查步骤给出链接）：信号类别、推送阈值、处理时间表和申请流程（设置 → 流程、`/interests`）。

## 设置完成之前

- 打开任何页面都会跳到 `/setup`（API、文件和表单提交不跳转）。
- runner 不跑定时轮次、启动时的补跑和每周建议，只记一行 `setup not completed: skipping …`，不算失败。你自己发起的轮次
  （向导的"立即跑第一轮"、设置 → 手动操作）照常运行，备份也照常。
- `pnpm run doctor` 在 `setup.completed` 给出警告；`cycle.last` 说明定时轮次在等首次设置。

步骤下面的"跳过向导，我自己配置"会立即把设置标为完成。设置完成后，定时轮次从下一个排定时刻开始。

## 重新打开

设置 → 手动操作 → "打开设置向导"（或直接打开 `/setup`）。设置已完成时，向导以回看模式打开：不跳转，定时轮次照常，每次保存立即生效。

## 命令行：`pnpm run setup`

在宿主机的项目目录里运行（单独的 `pnpm setup` 是 pnpm 自己的命令）：

```bash
pnpm run setup                         # 交互式走完八步；直接回车保留方括号里的值
pnpm run setup --step ai               # 只跑一步
pnpm run setup --answers answers.yaml  # 无人值守
pnpm run setup --status [--json]       # 设置进度和就绪清单（只读，不写任何文件）
pnpm run setup --complete              # 不改任何配置，直接标记完成
pnpm run setup --lang zh               # 提问的语言（默认 language.yaml 的 cli.locale）
```

AI 步骤在这台电脑上读取 `claude` 和 `codex` 是否安装、是否登录（`claude auth status`、`codex login status`，不调用 AI）。没有数据库
（stack 没在运行）时画像文件照常写入，历史快照在下次读取画像时补记；"跑第一轮"只会告诉你之后怎样启动。退出码：0 完成，1 某一步或
"完成"失败，2 参数错误或答案文件读不了。

### 答案文件

每一节都可以省略：省略的步骤记为跳过，省略的字段保留文件里现在的值。写入任何东西之前先校验整个文件。

```yaml
language:
  ui_locale: en                 # en | zh：默认界面语言（language.yaml 的 ui.default_locale）
  ai_output: en                 # AI 文字的语言（语言代码）
  translation_target: en        # 岗位翻译成这种语言
market:
  pack: generic                 # config/packs/ 下的一个目录
  country: NL                   # ISO 代码；省略则用市场包的
  currency: EUR
  home_language: nl
  locations: [Amsterdam, Utrecht]
  remote_scope: home_country    # none | home_country | worldwide | {region: [eu, CH]}
  timezone: Europe/Amsterdam
profile:
  summary: Backend engineer moving into applied machine learning.
  skills:
    - { name: Python, years: 6 }
    - Kubernetes
  languages: { en: C1, nl: A2 } # A1–C2 或 native
  years_experience: 7
  city: Amsterdam
  needs_visa_sponsorship: false
targets:
  target_titles: [Machine Learning Engineer, Data Engineer]
  seniority: senior             # all | entry | mid | senior | lead
  workplace: [hybrid, remote]
  salary_floor_year: 65000      # 按市场的基准货币
  contracts: { allow: [permanent], exclude: [temp_agency] }
  exclude_student_roles: true
  exclude_companies: [Example Staffing]
  exclude_keywords: [unpaid]
sources:
  enable: [greenhouse, lever]   # sources.yaml 里的渠道 id
  acknowledge_scraping: false   # 启用 linkedin-guest、indeed、stepstone、xing、jobspy-google 或 LinkedIn 会话渠道时必须为 true
  disable: [linkedin-brightdata]
  boards:
    - { name: Example Co, ats: greenhouse, token: exampleco }
ai:
  order: [claude-cli, codex-cli, api]
  providers:
    claude-cli: { enabled: true, model: claude-sonnet-5-5 }
    mimo: { enabled: false }
telegram:
  enabled: false
  notify_locale: null           # 消息语言；null = 界面默认语言
finish:
  complete: true                # 步骤走完后把设置标为完成（默认 true）
  run_first_cycle: false        # 排一个第一轮（需要数据库）
```

启用抓取类或账号类渠道（`linkedin-guest`、`indeed`、`stepstone`、`xing`、`jobspy-google`、LinkedIn 登录会话）时，`sources.acknowledge_scraping` 必须为 `true`，否则返回 `consentRequired` 且不写任何文件。

## setup.yaml

状态放在用户配置目录的 `data/config/setup.yaml`（见 [configuration.zh.md](configuration.zh.md)）：

```yaml
completed_at: null              # 完成或跳过后是 ISO 时间
completed_by: null              # wizard | cli | skipped | existing_install
steps:
  language: { status: done, at: "2026-10-09T08:00:00Z" }
```

只有这个文件读得出来、并且 `completed_at` 是 null 时，才算"设置未完成"。读不了或内容不合法时按"已完成"处理（不会把人锁在
向导里），由 `pnpm run doctor` 在 `setup.completed` 报出来。

**老安装**不会看到向导：用户配置目录里已经有配置文件、但没有 `setup.yaml` 时，第一次启动（web、runner 或 `pnpm config:init`）会写入
`completed_by: existing_install`。在已经配置好的安装上删掉 `setup.yaml`，下次启动也会这样处理。仍想走一遍，直接打开 `/setup`。
