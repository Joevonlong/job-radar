# 隐私：存了什么、什么会离开本机、怎么彻底删除

[English](privacy.md) | [中文](privacy.zh.md)

Job Radar 是跑在你自己机器上的单用户工具：没有账号、没有遥测、没有更新检查、没有托管服务，页面运行时也不加载任何外部资源（字体已内置）。
本页列出它存了什么、哪些外部服务可能收到你的一部分数据，以及怎么全部删除。这是技术说明，不是法律意见。

## 存了什么，存多久

| 数据 | 位置 | 保留 |
|---|---|---|
| 你的画像（`me.yaml`：技能、年限、语言、简介；`preferences.yaml`：目标职位、城市、薪资底线、排除的公司和关键词；`stories.yaml`：经历素材库，`writer.yaml: enabled` 为 false 时不发到任何地方） | 宿主机 `data/profile/` | 直到你删除 |
| 画像的每个历史版本（完整 YAML 文本） | 数据库表 `profile_snapshots` | 直到你删除数据库；没有清理任务 |
| 配置，包括你自己的评分标准（`ai.yaml`） | `data/config/`，编辑器备份在 `data/config/.backup/` | 编辑器备份有上限；迁移备份不会自动清理 |
| 申请、下一步、备注、收藏及收藏备注 | 数据库 | 直到你删除数据库（取消收藏时收藏备注一起删除） |
| 各渠道原样的原始岗位，以及未解析的职位提醒邮件（整封） | 数据库表 `raw_postings` | 直到你删除数据库 |
| 付费交付账本：供应商记录原文和无法读取的响应体；已存岗位使用链接和哈希，不重复保存原文 | 本机 Postgres，包含在数据库备份中 | 账本条目默认 45 天；运行摘要保留到删除数据库。旧备份可能仍保留已删除条目。 |
| 邮件元数据（Message-ID、发件人地址、IMAP UID） | 数据库表 `email_messages` | 直到你删除数据库 |
| AI 结果（评分及理由、翻译、拆解、信号、陷阱标记、带引文的每周建议）和 AI 用量记录（模型、token、耗时） | 数据库 | 直到你删除数据库 |
| 已发出的 Telegram 消息（内容和消息 id）、控制请求及结果 | 数据库 | 直到你删除数据库；写作请求（`writer_job`）的素材在请求完成、失败或过期（排队时看 `writer.yaml: queue_timeout_seconds`，运行时看 `timeout_seconds` + `expiry_grace_seconds`）后即从请求里清除。请求未结束时做的备份会留下这些素材，包括部署时的迁移前备份：日备和周备约保留 8 周，系统备份和手动备份更久。Postgres 的堆和 WAL 也可能留着，直到 vacuum 和 checkpoint。 |
| 申请问题和回答版本，以及每句话的依据核对结果 | 数据库表 `application_questions`、`application_answer_versions` | 直到你删除问题（或数据库）；超过 `questions.max_versions_per_question` 时删除最旧的版本 |
| runner 心跳 | 数据库 | 24 小时 |
| 数据库备份 | `data/backups/` | 自动：14 份日备、8 份周备；手动备份不会被清理。已删除的记录在旧备份里还会留着，直到这些备份被删掉 |
| 给 resume-kit 的 JD 导出 | `data/exports/jd/` | 直到你删除 |
| 日志 | 容器日志（轮转）、`data/logs/`（轮转）、macOS 上的 `~/Library/Logs/job-radar/` | 轮转 |
| 密钥：Gmail 应用密码、Telegram token 和 chat id、API key | `.env` | 直到你删除 |
| LinkedIn 登录态（仅当你用登录会话时） | `.auth/` | 直到你删除 |
| AI 命令行调用的临时文件 | `$TMPDIR/jr-codex-*`、`jr-claude-*` | 每次调用后删除（进程被强杀可能残留） |

操作日志只存在本机 Postgres，保存 ID、代码、数字和时间，不保存消息正文、错误正文、URL、职位描述或 Telegram 消息，也不会增加对外连接。保留和删除方式见[操作日志](sources.zh.md#操作日志)。

交付账本留在本机，不通过 MCP 或网页公开。保留期可在 [delivery-audit.yaml](configuration.zh.md#付费交付账本delivery-audityaml) 中配置。

上面其他数据库表目前没有自动保留期：原始岗位、未解析邮件、通知、控制请求和画像快照会一直留到你删除数据库。`data/` 包含上面的全部内容，
请不要放在云同步盘或共享目录里。备份文件和导出的 JD 文件含有个人数据。

归档、休眠和再次出现都不会删除任何数据：岗位、原帖、评分、翻译和分析一直保留在本机。将来若增加保留期，默认关闭。

## 什么会离开本机

| 谁 | 发什么 | 何时 | 怎么停止 |
|---|---|---|---|
| 你使用的 AI 提供方：OpenAI（`codex` 命令行或 API）、Anthropic（`claude` 命令行或 API）、OpenRouter 及它转发到的上游提供方（API）、DeepSeek 或小米 MiMo（API，**默认关闭**）。API 提供方在 `.env` 里填了 key 之前什么都不发 | **评分：** 画像摘要、技能和年限、语言等级、**目标职位、目标城市、工作方式、远程范围、级别、薪资底线、合同偏好、排除的公司、排除的关键词、你自己的评分标准**，加上岗位描述。**每周建议：** 你标记过的岗位（感兴趣、准备中、已申请、面试中、offer、忽略）**及其状态**，加上你的偏好。**翻译、拆解、信号、陷阱检查：** 只有岗位文本。**申请写作**（默认关闭）：只发送“生成”上方披露框列出的素材：问题及其设置、职位名称和公司、勾选的 JD 要点或一段 JD 原文、画像简介、技能和语言、勾选的经历素材和你的强调说明，在你按**生成**时发送。你的居住城市和签证状态（`me.yaml`）、备注和申请备注不会发送。 | 每一轮；申请写作只在你点击时 | 关掉该提供方（`ai.yaml` 里 `enabled: false`，或"设置 → AI"），不安装它的命令行、不填它的 key；每周建议用 `schedule.yaml` 的 `suggest.enabled` 关掉；`writer.yaml: enabled` 保持 `false` |
| 招聘网站与 API：Arbeitsagentur、Indeed、LinkedIn、StepStone、XING、JSearch 的 Google Jobs、公司招聘看板、Bright Data、Apify、Monid | 搜索关键词、搜索城市或本国名、关注名单里的公司名，以及来自你的 IP 的请求（LinkedIn session 以你自己登录的账号发出） | 每轮采集；公司查询仅发给支持且已启用的通道 | 在来源页关闭通道；公司查询可在 `search.yaml` 设 `watched_company_queries.enabled: false` 全部关闭，或在 `sources.yaml` 的通道块设 `company_queries: false` 单独关闭 |
| Arbeitnow（免费招聘板接口） | 只有来自你 IP 地址的请求（它不收关键词和地点） | 每一轮 | 在"来源"页关掉该通道 |
| Tavily 或 Brave（招聘页发现） | 形如"关键词 jobs 城市"的搜索词 | 每天，且仅在有 key 时 | 不设置 key |
| Google（Gmail，IMAP） | 用应用密码登录并读取一个标签 | 每一轮 | 关掉 Gmail 通道；撤销应用密码 |
| Telegram | 职位名、公司、分数、AI 一句话摘要、提醒、健康告警，以及用"定制简历"按钮时的命令文本 | 推送时 | Telegram 默认关闭（`notify.yaml`），保持关闭即可 |
| 终端里的 `claude`（resume-kit `/tailor`） | **你的完整简历**和岗位描述，仅当你自己运行这条命令时 | 只在你运行时 | 不运行它 |
| 你自己配置的 MCP 客户端（Claude Desktop、Claude Code 等）所用的模型服务商（**默认关闭**） | 你提问时工具返回的内容：岗位事实字段、来源链接、分数与排名、带 JD 引用的信号、经 AI 陷阱清洗的 JD、申请的状态 / 日期 / 下一步 / 面试轮数。**永远不给：** 画像、匹配理由和差距、过滤原因、薪资底线、备注、邮件、本机路径、密钥。见 [mcp.zh.md](mcp.zh.md) | 只在你向客户端提问时 | 保持 `mcp.yaml: enabled: false`，或从客户端里删掉这个服务 |

不会向项目维护者或任何统计服务发送任何东西。

### AI 提供方怎么保存

- **订阅命令行**（`codex`、`claude`）适用你的 ChatGPT 或 Claude 订阅的消费者条款。Job Radar 启动它们时不保存会话，但提供方怎么使用内容（例如用来改进模型）
  取决于**你账号里的设置**：在 ChatGPT（设置 → 数据控制）里查看"为所有人改进模型"，在 Claude（设置 → 隐私）里查看"帮助改进 Claude"，不想被用就关掉。
- **API key** 适用提供方的商业或 API 条款，通常默认不会拿你的数据训练；请阅读你所用提供方的条款。
- **OpenRouter** 是转发服务：它把每个请求转给所选模型的某个上游提供方，可能是另一家公司、在另一个国家（默认模型的上游可能是 DeepSeek，见下条）。Job Radar 要求它只用不存储、不拿 prompt 训练的上游（`providers.openrouter.routing.data_collection: deny`）。这**不是**零数据保留：上游仍可能把请求保留一段时间。在 `ai.yaml` 里设 `routing.zdr: true` 只允许零数据保留的上游（能用的模型会变少）。你 OpenRouter 账号里的设置同样生效。
- **DeepSeek 和小米 MiMo** 由中国境内运营，发给它们的数据受中国法律管辖。它们默认关闭，只有接受这一点时才打开。
- **经 OpenRouter 到 DeepSeek：** 填了 OpenRouter 的 key 并使用它的默认模型（`deepseek/deepseek-v4.1-flash`）时，即使
  `deepseek` 服务商是关着的，你的数据也可能到达 DeepSeek 自己在中国境内运营的上游。不想这样，可以给 OpenRouter 选一个
  不是 DeepSeek 的模型（设置 → AI → OpenRouter，或 `providers.openrouter.model`），在你 OpenRouter 账号设置里把
  DeepSeek 加进忽略的提供方，或者不填 `OPENROUTER_API_KEY`。
- **Telegram** 把 bot 消息存在它的服务器上，不是端到端加密。能访问该聊天、你的账号或 bot token 的人都能读到。
- **Gmail 应用密码**能访问整个邮箱，不只是 Job Radar 读的那个标签。建议用一个只接收职位提醒的专用邮箱，不用时撤销密码。

已打开且可用的提供方（"设置 → AI"、`pnpm run doctor`）就是可能收到你的画像摘要和岗位文本的服务。

## 彻底删除

不再使用 Job Radar，或想清除求职痕迹时这样做。不可撤销。

1. **先备份要保留的东西**（比如 `data/profile/` 和 `data/config/`），复制到项目目录之外。
2. **卸载这套安装：** 停掉宿主机 AI worker，删除容器，**删除数据库卷 `jobradar-pg`**（这一步才会删掉所有已存的岗位、申请和备注），删除 `data/`、`.env`、`.auth/` 和代码目录。
   命令见[卸载](upgrade.zh.md#卸载)。
3. **备份和别处的副本：** 删除 `data/backups/`（随 `data/` 一起），以及你复制到其他磁盘或云盘的备份，还有导出的 JD 文件和定制好的简历（`data/exports/`、resume-kit 的输出目录）。
4. **日志和临时文件：** macOS 上的 `~/Library/Logs/job-radar/`，以及被强杀的 AI 调用可能留下的 `$TMPDIR/jr-*`。
5. **账号：** 撤销 Gmail 应用密码（Google 账号 → 安全 → 应用专用密码）；在 BotFather 里删除 Telegram bot（`/deletebot`）并清空聊天；退出 LinkedIn 会话；
   删除只为它创建的 API key（Anthropic、OpenAI、OpenRouter、DeepSeek、MiMo、JSearch、Tavily、Bright Data、Apify、Monid）。
6. **AI 提供方那边：** `codex` 和 `claude` 命令行不会保存来自 Job Radar 的本地会话，但你的提供方账号可能按你的套餐保留对话历史或用量记录：需要的话请在那边删除。

当前版本的网页界面没有"删除单个岗位或申请"的功能。删除数据库卷（第 2 步）是清除已存岗位和备注的受支持方式；想继续使用的话，之后用一个空库重新开始。
