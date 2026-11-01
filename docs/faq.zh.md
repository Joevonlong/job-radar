# 常见问题

[English](faq.md) | [中文](faq.zh.md)

简短回答，详细内容见各篇指南。

**日常使用**

- [它会替我投简历吗？](#它会替我投简历吗)
- [打分是怎么算的？](#打分是怎么算的)
- [怎么加一家公司的招聘页？](#怎么加一家公司的招聘页)
- [怎么换语言？](#怎么换语言)
- [能在手机上用吗？](#能在手机上用吗)

**费用和 AI**

- [要花多少钱？](#要花多少钱)
- [需要什么 AI？](#需要什么-ai)
- [会不会把我的 Claude 或 ChatGPT 额度用光？](#会不会把我的-claude-或-chatgpt-额度用光)

**隐私、来源、市场**

- [哪些东西会离开我的机器？](#哪些东西会离开我的机器)
- [它读哪些招聘网站？](#它读哪些招聘网站)
- [抓取招聘网站合规吗？](#抓取招聘网站合规吗)
- [我不在德国，能用吗？](#我不在德国能用吗)

**运行**

- [几个人能共用一套吗？](#几个人能共用一套吗)
- [电脑必须一直开着吗？](#电脑必须一直开着吗)
- [能在 Windows 上跑吗？](#能在-windows-上跑吗)

## 它会替我投简历吗？

不会。Job Radar 不会自动投递，也从不在招聘网站上填任何表单。它负责找、读、打分、跟进；拿主意和投递是你的事。需要定制简历时，
它导出 JD，并给你一条 resume-kit 的命令；resume-kit 是一个独立工具，由你自己运行（[resume-kit.zh.md](resume-kit.zh.md)）。

## 打分是怎么算的？

1. **先过硬过滤。** 不在你的城市、低于薪资底线、合同类型被你排除、或者来自拉黑公司的岗位，不花任何 AI 调用就被过滤掉。
   它们不会被删：你仍然能看到，并看到被过滤的原因。
2. **剩下的由 AI 打 0–100 分。** AI 读 JD，同时参考你的画像摘要、技能、语言、求职偏好和你自己写的打分标准（最看重的、加分项、
   绝不接受的），给出分数、合适的理由和差距。碰上“绝不接受”的岗位，分数落到 0–29。
3. **信号加分，有上限。** 你的信号类别（写明的薪资、股权、福利，或任何你定义的）在分数上再加分。排序值 = 匹配分 + 信号加分，
   加分有上限（默认 15）。列表按排序值排。
4. **推送看排序值。** 默认排序值 70 以上推送；有高价值信号的，60 以上就推。

改了打分标准后，现有分数会标成“过期”，在接下来的几轮里重新打分。改了画像之后，可以在 设置 → 手动操作 → “重打 N 条过期分数”
把旧分数更新。详见 [signals.zh.md](signals.zh.md)、[usage.zh.md](usage.zh.md)、[telegram.zh.md](telegram.zh.md)。

## 怎么加一家公司的招聘页？

Job Radar 能读放在 Greenhouse、Lever、Ashby、Personio、SmartRecruiters 上的公司招聘页。

- **在网页上：** 来源 → 来源清单（`/sources/registry`）→ 添加公司：填公司名、ATS 和 token（这家公司在那个 ATS 上的标识，
  通常是它招聘页地址的最后一段）。点“打开 board”可以确认填对了。
- **在文件里：** 在 `data/config/sources.yaml` 的 `ats_boards` 下加一条。
- **让它自己找：** 配了 Tavily 的 key（有免费档）之后，Job Radar 大约每天搜一次新的招聘页，列在来源页上，由你决定添加还是忽略
  （[tavily.zh.md](tavily.zh.md)）。

对应的 ATS 通道本身要是开着的。详见 [sources.zh.md](sources.zh.md)。

## 怎么换语言？

- **界面：** 顶栏的语言按钮在中文和英文之间切换（按浏览器记住）。
- **其他所有语言：** 设置 → 界面 → 语言（文件是 `language.yaml`）。在这里设默认界面语言、AI 写字用的语言（任何语言代码，
  比如 `de`、`pt-BR`）、JD 翻译成的语言，以及 Telegram 消息和命令行工具的语言。

想加一种界面语言，就加一个消息文件。详见 [languages.zh.md](languages.zh.md)。

## 能在手机上用吗？

能，有两种方式：

- **Telegram：** 过线的岗位以带按钮的消息推过来。为此你的机器不需要对公网开放任何东西。
- **看板：** 手机宽度下完整可用。通过 Tailscale 打开（`tailscale serve --bg 3000`），它只在你自己的私有网络里。

不要在路由器上转发 3000 端口，也不要用公网隧道：没设口令时看板没有登录，谁能访问到它，谁就能以你的身份操作。如果有别人共用你的 tailnet，
用 `pnpm web:password` 设一个口令。设置方法见 [installation.zh.md](installation.zh.md#8-可选在手机上打开tailscale)。

## 要花多少钱？

Job Radar 本身免费、开源（AGPL-3.0），跑在你自己的机器上。可能花钱的都在它之外：

- **AI：** 你已经有的 `claude` 或 `codex` 订阅，读多少岗位都不额外收费。API key 按 token 计费，到你设的月预算
  （`ai.yaml` 里的 `monthly_api_budget_usd`）就停。
- **可选来源：** Bright Data 和 Apify（LinkedIn 的付费兜底）从你的账户扣费；JSearch（Google Jobs）和 Tavily（发现公司招聘页）
  有免费档。每个付费或需要 key 的来源都有月预算。

不接 AI、只用免费来源的话，除了电费不花钱。AI 用量和费用在 `/sources/ai-usage`（[ai-usage.zh.md](ai-usage.zh.md)）。

## 需要什么 AI？

一开始不需要：没有 AI，Job Radar 照样采集、去重、过滤、展示岗位。接上下面任意一个之后，打分、翻译、岗位拆解和 AI 信号复核才开始工作：

| | 怎么接 |
|---|---|
| Codex CLI（订阅） | 在跑 AI worker 的机器上 `codex login` |
| Claude Code（订阅） | 运行 `claude`，然后 `/login` |
| Anthropic、OpenAI、OpenRouter、DeepSeek 或 MiMo（API） | 把 key 填进 `.env`；DeepSeek 和 MiMo 还要在 `ai.yaml` 里打开 |

默认先试 codex，再试 claude，最后才是 API。顺序、模型和每类任务的推理强度都能在设置页的 AI 标签里改。`pnpm ai:probe`
显示现在哪些可用。详见 [ai-providers.zh.md](ai-providers.zh.md)。

## 会不会把我的 Claude 或 ChatGPT 额度用光？

设计上就是为了不让这种事发生。每个订阅命令行都有每日上限（默认 claude 100 次、codex 200 次）；claude 排在 codex 后面，
因为你自己多半也在用 claude。服务商报告额度用尽时，所有进程都会暂停用它，直到报错里写的恢复时间。每一轮还有 AI 的时间预算
（默认 30 分钟），装不下的留到下一轮。这些都能在 `ai.yaml` 或设置页里调（[ai-providers.zh.md](ai-providers.zh.md)）。

## 哪些东西会离开我的机器？

岗位、画像和申请记录都在你机器上的数据库里。不用注册，没有遥测，没有托管服务。会发出去的是：

- **发给你配置的 AI：** 打分时是 JD 正文，加上你的画像摘要、技能、语言、求职偏好（目标职位、城市、薪资底线、排除的公司和
  关键词、合同类型）和你的打分标准；翻译和拆解只发 JD 正文；你点“查询薪资”时发公司、职位、城市、国家和级别；每周建议会发你标记过的岗位和它们的申请状态（可在 `schedule.yaml`
  用 `suggest.enabled` 关掉）。
- **发给 Telegram：** 推送消息，发到你自己的 bot（前提是你设置了），存在 Telegram 的服务器上。
- **发给你开启的来源：** 拉取岗位的请求，以及检查岗位是否还在线的请求。需要 key 的搜索 API 还会看到你的搜索词。

某个服务商不可用时会由下一个接手，所以你开着的每个服务商都可能收到这些文本；不想让某家收到，就把它关掉（[哪些服务商会收到 JD 文本](ai-providers.zh.md#哪些-provider-会收到岗位文本)）。

用订阅命令行时适用的是服务商的消费者条款，请自己确认它的数据和训练设置。你运行定制简历的命令时，它会把你的完整简历和 JD 发给 Claude。

数据库里的东西目前不会自动删除：原始帖子、邮件和通知会一直留着，直到你删掉数据库。存了什么的完整清单、各 AI 服务商的数据政策、彻底删除的步骤见
[privacy.zh.md](privacy.zh.md)。

## 它读哪些招聘网站？

| 类型 | 来源 | 需要 | 新安装时 |
|---|---|---|---|
| 招聘网站（官方） | Arbeitsagentur（德国联邦劳工局）、Arbeitnow（免费公开的招聘板接口） | 什么都不用 | 开（德国包） |
| 招聘网站（抓取） | LinkedIn 游客搜索、Indeed、StepStone、XING | 什么都不用 | 关：向导先提示风险、问过你 |
| 公司招聘页 | Greenhouse、Lever、Ashby、Personio、SmartRecruiters | 什么都不用；公司由你添加 | 开 |
| 搜索 API | 通过 JSearch 的 Google Jobs | RapidAPI 的 key（有免费档） | 关；key 填进 `.env` 后再打开 |
| 你的邮箱 | Gmail 某个标签下的职位提醒邮件 | Gmail 应用专用密码 | 关；密码填进 `.env` 后再打开 |
| 更稳的 LinkedIn | 你自己的登录态（有风险，见它的说明）、Bright Data、Apify | 登录一次，或付费 key | 登录态关；Bright Data / Apify 没 key 什么都不做 |

开哪些由你决定，一个挂了不影响其他的。缺 key 的来源显示“未配置”，不发任何请求。所有来源和各种状态见 [sources.zh.md](sources.zh.md)。

## 抓取招聘网站合规吗？

这取决于网站和你所在的地方，以下不构成法律意见。部分来源读取公开网页或非官方接口，有的网站服务条款禁止自动访问。用你自己的
LinkedIn 登录态去读，违反 LinkedIn 的用户协议，账号可能被限制。

Job Radar 做的：所有抓取类来源一开始都是关的，打开前先让你确认风险；限制请求频率，从不尝试绕过登录墙、验证码或验证页，来源持续失败时停用它。你要做的：每个开启的网站都先看它的条款，
控制请求量，尽量用官方接口和你自己的提醒邮件，不要再发布它采集到的内容。使用方式由你自己负责。

## 我不在德国，能用吗？

能。默认配置不预设国家，你在设置向导里选自己的市场。市场包装着一个国家特有的东西：城市和地区、本地语言规则、基准货币和它的招聘网站。
随产品附带一个中性包（`generic`）和一个德国 / 欧盟包（`de`）。别的国家，把一个包复制到 `data/config/packs/` 改一改就行
（[market-packs.zh.md](market-packs.zh.md)）。公司招聘页、LinkedIn、Indeed 和 Google Jobs 在很多国家都能用；StepStone、XING、
Arbeitsagentur 和 Arbeitnow 是德国包自带的招聘网站。

薪资识别认得欧元、美元、英镑，还有很多别的货币（包括 CAD、AUD、SGD、JPY、CNY、INR、BRL、ZAR），汇率是可以调整的粗略值；
你的货币没有汇率时，市场表单会提示。Indeed 不覆盖的国家里只有 Indeed 受影响，其他来源照常工作。Indeed 已不再覆盖斯洛伐克、斯洛文尼亚、克罗地亚、保加利亚、爱沙尼亚、拉脱维亚、立陶宛、马耳他、塞浦路斯和孟加拉国（SK、SI、HR、BG、EE、LV、LT、MT、CY、BD）：这些市场里开着 Indeed，它每轮都会以 `unknown` 失败（“Indeed does not serve …”，不是被跳过），直到熔断器打开，所以在那里请关掉 Indeed。在欧洲以外的话，先拿几个岗位核对一下薪资结果。

## 几个人能共用一套吗？

不能。Job Radar 是一人一套：一份画像、一套偏好、一个 Telegram 聊天。两个人就装两套，各自有自己的数据库。应用里没有用户账号，
也不打算做。

一台机器上能放两套：再克隆一份，在它第一次启动之前，在它的 `.env` 里设好自己的 compose 项目名、数据库卷和端口（`COMPOSE_PROJECT_NAME`、
`JOBRADAR_PG_VOLUME`、`JOB_RADAR_WEB_PORT`、`DB_HOST_PORT`）。每套还要有自己的 Telegram bot。详细步骤见
[multiple-instances.zh.md](multiple-instances.zh.md)。

## 电脑必须一直开着吗？

要按时跑处理轮的话，是的：Job Radar 跑在你的机器上，不在云上。如果到点时机器是关着的，runner 下次启动时会补跑一次，错过的备份也会补上。
想让 Mac 无人值守（重启后自动登录、登录时启动 Docker、断电恢复后自动开机、不睡眠），按 [host-setup.zh.md](host-setup.zh.md) 做。
推送还需要 AI worker 在跑。

## 能在 Windows 上跑吗？

能，在 WSL2 里跑。把仓库克隆到 Linux 文件系统里（比如 `~/job-radar`，不要放在 `/mnt/c` 下，那里绑定挂载慢、权限也不一样），
在 Docker Desktop 里为这个发行版打开 WSL 集成，在 WSL 里装 Node、pnpm 和 `claude` / `codex` 命令行。之后按 Linux 的步骤走；
AI worker 也在 WSL 里跑，看板在 Windows 浏览器里打开 <http://127.0.0.1:3000>。说明见 [平台说明](installation.zh.md#macoslinuxwindows)。
Job Radar 日常在 macOS 和 Linux 上运行，WSL 上有哪里表现不一样，欢迎提 issue。

---

这里没有你的问题？到 [Discussions](https://github.com/Joevonlong/job-radar/discussions) 提问，或者看 [docs/](README.zh.md) 里的全部指南。
