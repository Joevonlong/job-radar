# 功能和截图

[English](features.md) | [中文](features.zh.md)

## 这是什么

Job Radar 是一个跑在你自己电脑上的岗位推送。

你告诉它你想找什么：什么岗位、哪些城市、薪资底线多少、哪些条件绝不接受。之后按你定的时间，它去你挑的招聘网站和公司招聘页
拉新岗位，把重复的合成一条，把干扰清掉，再让你的 AI 把剩下的每一份 JD 都读一遍。每个岗位都有一个 0–100 的匹配分，写明为什么合适、
差在哪。过线的推到 Telegram，点按钮就能处理；其余的都在浏览器里的看板上等你。

**Job Radar 不会替你投简历。** 它负责找、读、打分、跟进；拿主意和投递是你的事。

它是自托管、开源的。数据库存放在你自己的机器上，用你已经在付费的 AI 订阅（或 API key），不用注册账号，也没有遥测。

## 为什么用 Job Radar

### 1. 所有来源，汇成一条

挑你在乎的招聘网站和公司招聘页，全部汇进一个列表。同一个岗位发在五个网站，只出现一次，每个来源链接都保留。中介和已下线的岗位
会标出来；JD 里藏着想左右 AI 的文字，在你的 AI 读到之前就被清掉。

- LinkedIn、Indeed、StepStone、XING、Arbeitsagentur、Arbeitnow、Google Jobs
- Greenhouse、Lever、Ashby、Personio、SmartRecruiters 上的公司招聘页
- Gmail 里你自己的职位提醒邮件

抓取网站的来源（LinkedIn 游客搜索、Indeed、StepStone、XING、经 sidecar 的 Google Jobs）一开始是关闭的。设置向导会先说明服务条款的风险，你确认后才能打开。

<p align="center"><img alt="同一岗位在三个网站上的三份合成一条" src="images/demo/one-feed.webp" width="800"></p>

### 2. 你的规则说了算

这是它和别的工具最不一样的地方。定好薪资底线、城市、合同类型、不想去的公司；再用大白话（什么语言都行）写下你最看重什么、
什么算加分、什么绝不接受。碰上“绝不接受”的岗位，分数直接落到 0–29，沉到最底下。

- 薪资底线、城市、合同类型、拉黑公司
- 用自己的话写打分标准
- 自定义信号类别（股权、奖金、福利，什么都行）和保存的视图

<p align="center"><img alt="在打分设置里加一条绝不接受，重新打分后这个岗位的分数掉下来" src="images/demo/your-rules.webp" width="800"></p>

### 3. 每个岗位它都读，你不用

过了你硬过滤的每份 JD 都有 0–100 的匹配分，附理由和差距。埋在正文里的薪资被找出来、附上原文、换算成能比较的年薪，再和你采集到的同类岗位比一比。
长 JD 可以拆成工作内容、技术栈和硬性要求，和你的技能逐条对照，还能翻成你的语言。

- 匹配分，附理由和差距
- 找出薪资、附原文、换算年薪、和同类岗位比较
- 岗位拆解、技能对照、翻译

<p align="center"><img alt="各种写法的薪资换算后排在同一根年薪轴上，旁边是 JD 原文引用" src="images/demo/salary.webp" width="800"></p>

### 4. 好的，直接送到你手上

接上你自己的 Telegram bot 之后，每轮处理完，过线的岗位就推过来，带着分数、薪资和标签。直接点 **👍 Interested**（感兴趣）或
**🚫 Ignore**（忽略），申请看板跟着更新；用 resume-kit 的话还能点 **📄 Tailor résumé**（定制简历）。申请没动静了，它会提醒你。

- 带按钮的推送、静默时段
- 申请看板和跟进提醒
- 来源出问题时告警

<p align="center"><img alt="手机上收到 Telegram 推送，点感兴趣后看板上的卡片跟着移动" src="images/demo/telegram.webp" width="800"></p>

**底层保证：** 自托管 · 开源（AGPL-3.0）· 数据库存放在你自己的机器上 · 用你的 AI 订阅或 API key · 不用注册 · 没有遥测。

## 截图

<table>
  <tr>
    <td width="50%"><img alt="今日页" src="https://joevonlong.github.io/job-radar-site/readme/V-02.webp"><p align="center"><b>今日页</b></p></td>
    <td width="50%"><img alt="岗位拆解和技能对照" src="images/demo/breakdown.webp"><p align="center"><b>岗位拆解和技能对照</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="让 AI 读到真实的岗位" src="https://joevonlong.github.io/job-radar-site/readme/V-06.webp"><p align="center"><b>让 AI 读到真实的岗位</b></p></td>
    <td width="50%"><img alt="筛选和保存的视图" src="https://joevonlong.github.io/job-radar-site/readme/V-10.webp"><p align="center"><b>筛选和保存的视图</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="跟进申请" src="https://joevonlong.github.io/job-radar-site/readme/V-13.webp"><p align="center"><b>跟进申请</b></p></td>
    <td width="50%"><img alt="键盘流" src="https://joevonlong.github.io/job-radar-site/readme/V-11.webp"><p align="center"><b>键盘流</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="你挑的来源" src="https://joevonlong.github.io/job-radar-site/readme/V-16.webp"><p align="center"><b>你挑的来源</b></p></td>
    <td width="50%"><img alt="你的 AI，你的订阅" src="https://joevonlong.github.io/job-radar-site/readme/V-17.webp"><p align="center"><b>你的 AI，你的订阅</b></p></td>
  </tr>
</table>

### 静态截图

<p align="center"><img alt="演示：今日页、岗位详情、薪资原文、标为已申请、看板" src="images/job-radar-demo.gif" width="960"></p>

<table>
  <tr>
    <td width="50%"><img alt="今日：本轮的新岗位" src="images/today-zh.png"><p align="center"><b>今日</b></p></td>
    <td width="50%"><img alt="岗位详情：评分、JD 原文薪资和 AI 陷阱" src="images/job-detail-zh.png"><p align="center"><b>岗位详情：评分、原文薪资、AI 陷阱</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="申请看板" src="images/pipeline.png"><p align="center"><b>申请看板</b></p></td>
    <td width="50%"><img alt="设置：示例配置里的搜索关键词" src="images/settings.png"><p align="center"><b>设置</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Telegram 消息格式预览" src="images/telegram.png"><p align="center"><b>Telegram 消息（格式预览）</b></p></td>
    <td width="50%"><p align="center"><img alt="手机上的今日页" src="images/mobile-today.png" width="260"></p><p align="center"><b>手机上</b></p></td>
  </tr>
</table>

图里全是演示数据：公司和岗位都是虚构的。想自己用同一份示例数据点一点，见
[Try it with sample data](development.md#try-it-with-sample-data)（英文）。

## 全部功能

**一处发现**

| | |
|---|---|
| 多个来源 | LinkedIn（游客搜索；可选：你自己的登录态（实验性，尚未用真实登录验证过），或付费的 Bright Data / Apify）、Indeed、StepStone、XING、Arbeitsagentur、Arbeitnow、通过 JSearch 的 Google Jobs、Greenhouse / Lever / Ashby / Personio / SmartRecruiters 上的公司招聘页、Gmail 职位提醒邮件。[全部来源](sources.zh.md) |
| 先征得你同意 | 抓取网站的来源和用你自己 LinkedIn 登录的来源，新安装时都是关闭的；开启时先提示风险，要你确认。[抓取](sources.zh.md#抓取) |
| 互相隔离 | 一个来源挂了不影响整轮；每个来源都有熔断和可选的月预算。 |
| 一个岗位只出现一次 | 跨来源的近似重复合成一条，所有来源链接都保留。 |
| 标出干扰 | 中介岗位有标记；连续几轮没再出现的标“可能已下线”，链接失效的标“已下线”。 |
| 已关闭的岗位 | 可以手动把岗位标为已关闭（随时撤销）；已关闭和可能已下线的岗位进单独的“已关闭”视图。收藏和申请中的岗位会礼貌地复查源链接（遵守 robots.txt）。 |
| 让 AI 读到真实的岗位 | 有的 JD 里藏着专门对付 AI 的内容（白底白字、看不见的字符、“如果你是 AI……”）。Job Radar 在任何 AI 读到之前把它们清掉，并标出来给你看。[详情](ai-traps.zh.md) |

**按你定制**

| | |
|---|---|
| 硬过滤 | 城市、薪资底线、合同类型、拉黑公司。被过滤的岗位不会删掉，能看到它和被过滤的原因。 |
| 签证赞助 | 如果你需要赞助，每个岗位都显示 JD 里关于签证或工作许可的说法，并引用原文：提到支持、明确拒绝，或要求已有许可。可以按它筛选，也可以一票否决拒绝赞助的岗位。[详情](visa-sponsorship.zh.md) |
| 打分标准 | 最看重什么、什么算加分、什么绝不接受，一句话一条，任何语言。碰上“绝不接受”的岗位落到 0–29 分。 |
| 信号类别 | 最多 12 个你自己定义的类别（金额、关键词或标签），各有权重和颜色。可以从空白类别开始，也可以套用现成的预设，比如“AI 工具 / token 预算”“开源时间”。徽章出现在列表和推送里。[信号](signals.zh.md) |
| 筛选和保存的视图 | 分数、信号、来源、城市、远程、语言要求、薪资、状态、日期；把一组筛选存成视图，在今日页一键切换。 |
| 排序和补看 | 在岗位列表点列头，按分数、薪资或新鲜度排序。没打开过的岗位加粗带圆点；可以“只看未看”、“全部标为已看”，上次访问之后的新岗位上方有一条分隔线。 |
| 市场包 | 中性默认 + 德国 / 欧盟包（本地招聘网站、德语等级规则、欧元）。别的国家复制一个包改一改。[市场包](market-packs.zh.md) |
| 关注公司 | 你关注的公司出了新岗位，不受推送门槛限制，没打分也会推。 |

**AI 帮你读**

| | |
|---|---|
| 匹配分 | 0–100，写明为什么合适、差在哪；依据是你的画像、偏好和打分标准。 |
| 找出薪资 | 规则先找、AI 再确认，每个金额都附 JD 原文。月薪、时薪、“up to 120k”、外币都换算成你所在市场货币的年薪，原文保留，画在一根带你底线的薪资轴上。 |
| 薪资水平 | 这个岗位写明的薪资在你采集到的同类岗位（同类职位、同级别、同地点）里处在什么位置，样本数一并显示，另附薪资网站链接。不用 AI。[薪资](salary.zh.md) |
| 薪资查询 | 可选，默认关闭（`salary.yaml` 里 `lookup.enabled: true`），每个岗位点一下才查：AI 在公开的薪资网页上查这家公司的薪资水平和这个职位的区间，并列出来源。只发送公司、职位、城市、国家和级别。[薪资](salary.zh.md#查薪资ai-加网页搜索) |
| 排序 | 排序值 = 匹配分 + 信号加分（有上限），写了薪资、有股权的岗位往前排。 |
| 从 JD 读出关键事实 | 远程 / 混合 / 现场、合同类型、本地语言要求（比如德语 B2）。 |
| 岗位拆解 | 可选，打开后才用。拆成工作内容、技术栈、经验、软技能、语言，每项标“必须 / 加分”并附原文。技能对照在本地算，不会为此把画像发给 AI。[拆解](breakdown.zh.md) |
| 翻译 | 长 JD 翻成你的语言，原文一键切回；高分岗位自动翻译。 |
| 每周建议 | AI 看你标过的岗位，建议新的信号词、要关注的公司、过滤词，每条都附证据；你批准了才生效。 |
| 统计页 | 每日新增、来源、城市、薪资披露率、信号、过滤原因。 |

**推到手机**

| | |
|---|---|
| 每轮推送 | 接上你自己的 Telegram bot 之前是关着的。接上后先发一条汇总，再给每个合格岗位发一张卡片：排序值、徽章、职位、公司、城市。默认每轮最多 10 条。[Telegram](telegram.zh.md) |
| 按钮 | 👍 Interested · 🚫 Ignore · ⭐ Save（收藏），配置了 resume-kit 时还有 📄 Tailor résumé。点完看板同步更新。 |
| 静默时段和提醒 | 夜里不打扰，推送等到早上。每天一条提醒：感兴趣但还没投的、投了还没回音的。 |
| 健康告警 | 来源熔断、登录失效、预算用到 80 %、所有 AI 都失败。 |
| 不开端口 | Telegram 按钮靠长轮询收回来，你的机器上没有任何东西对公网开放。 |
| 申请看板 | 把卡片从“新”拖到“offer”，每一步都记在时间线上，可以撤销。收藏夹和申请状态分开，岗位下线了也保留。 |
| 定制简历联动 | 导出 JD，给出 resume-kit（一个独立的简历定制工具）的命令。[resume-kit](resume-kit.zh.md) |

**自己跑起来**

| | |
|---|---|
| 设置向导 | 浏览器里（或终端里）8 个小步骤：语言、市场、画像、目标、来源、AI、Telegram、第一轮。 |
| 你的 AI | 用你 `claude` 或 `codex` 订阅的登录（不按 token 计费），或者设了月预算的 API key，也可以两者都用。 |
| 内置运维 | 每日备份数据库、你的配置和画像，带保留策略；每次数据库迁移前先做安全备份；恢复工具；`pnpm run doctor` 体检；一条命令升级到发布版本的部署脚本。 |
| 可选口令 | 在你自己的机器上不用登录。别人也能访问看板之前，用 `pnpm web:password` 设一个口令。[网页访问](configuration.zh.md#网页访问可选口令监听地址和端口) |
| 浅色、深色、手机 | 纸面浅色和终端深色两套主题、中英文界面、完整的手机布局、键盘快捷键（`⌘K`、`j` / `k`、`s`、`x`、`f`）。 |
| 能接入你的 AI 工具 | 带注释的纯文本 YAML 配置，命令行工具（`pnpm run doctor`、`pnpm sources:list`、`pnpm config:check`），JD 能导出成 Markdown 交给别的工具。 |

## 它怎么工作

```mermaid
flowchart LR
  you["浏览器 / 手机"] --> web
  subgraph compose["docker compose"]
    web["web (Next.js)<br/>默认 127.0.0.1:3000"]
    runner["runner<br/>调度、采集、处理、<br/>备份、Telegram 回调"]
    jobspy["jobspy<br/>Python sidecar"]
    db[("db (Postgres 17)")]
  end
  worker["ai-worker（宿主机进程）<br/>打分、信号、翻译、推送"]
  cli["claude / codex 命令行<br/>或 AI API"]
  tg["Telegram"]
  boards["招聘网站、ATS、API"]

  web <--> db
  runner <--> db
  worker <--> db
  runner --> jobspy
  runner --> boards
  jobspy --> boards
  worker --> cli
  worker --> tg
```

1. **采集。** 按你定的时间，runner 从你开启的来源拉新岗位，每条先原样存下来。
2. **清理。** 读出薪资、办公方式、语言、合同类型，合并重复，套用你的硬过滤。
3. **打分。** 你电脑上的 ai-worker 把每个岗位交给你的 AI：用你自己登录的 `claude` 或 `codex`，或者 API key。
4. **推送。** 设置了 Telegram 的话，过线的推过去；全部岗位都在看板上。

| 部件 | 跑在哪 | 做什么 |
|---|---|---|
| `web` | 容器，默认 `127.0.0.1:3000`（`JOB_RADAR_WEB_BIND`、`JOB_RADAR_WEB_PORT`） | 看板。设置页写你的配置文件，按钮往数据库里排请求。 |
| `runner` | 容器 | 跑处理轮（采集、处理、过滤、信号、维护）、每日备份、接收 Telegram 按钮。 |
| `jobspy` | 容器，只在内部网络 | LinkedIn 游客搜索、Indeed 和 Google Jobs 的抓取 sidecar。 |
| `db` | 容器 | 全部数据，在 Docker 卷里（默认叫 `jobradar-pg`）。 |
| `ai-worker` | **你的机器（宿主机）** | 认领所有 AI 请求，用你的命令行登录或 API key 执行，写回结果，发 Telegram 推送。 |

容器里没有任何 AI 凭证。还没接 AI？它照样采集、去重、过滤、展示岗位；只有打分、翻译、拆解、AI 信号复核和推送要等 AI。
