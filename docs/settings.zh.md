# 设置页与手动操作

`/settings` 用表单编辑十个配置文件（`schedule.yaml`、`search.yaml`、`sources.yaml`、`ai.yaml`、`breakdown.yaml`、`salary.yaml`、`notify.yaml`、`ui.yaml`、`insights.yaml`、`resume.yaml`），其余文件（`pipeline.yaml`、`models.yaml`、`interests.yaml` 以及以后新增的）和表单没覆盖的键可以在"高级"标签里按原文编辑，保存前用和 runner 相同的 zod schema 校验，写回用户配置目录（默认 `data/config/`，每个标签的说明里写出实际路径；第一次保存一个还只在默认配置里的文件时，以默认文件为底稿生成，见 [`configuration.zh.md`](configuration.zh.md)），写回时保留 YAML 注释；runner 热加载后，保存条上显示"runner 已加载"（runner 没有心跳时改写成"runner 没有运行"，不会和侧栏的 OFFLINE 互相矛盾）。表单里没有的键（`doctor`、`deploy`、`execution`、`host_worker`、`test_channel`、LinkedIn 登录态细节等运维参数，大多含机器路径）在"高级"标签里改。

## 标签栏与 AI 标签的四个区块

标签栏：处理时间 · 搜索 · 来源 · AI · 拆解 · 薪资 · 推送 · 界面 · 申请流程，分隔线之后是"手动操作"（`/settings?tab=actions`）和"高级"（`/settings?tab=advanced`）。一个标签里可以放几张表单，每张对应一个文件、各自保存："界面"标签有 `ui.yaml` 和 `insights.yaml` 两张，"申请流程"有状态表和 `resume.yaml`。手动操作（立即跑一轮、重打过期分数、给未打分岗位打分、Telegram 测试、最近的请求）只在这个标签里，其他标签底部没有；旧链接 `/settings#rescore` 等改为 `/settings?tab=actions#rescore`。手动操作下面的"首次设置向导"卡片以回看模式重新打开设置向导（`/setup`）：不跳转，每次保存立即生效（[setup.zh.md](setup.zh.md)）。

AI 标签分四个带编号、各有边框的区块（只是界面分组，`ai.yaml` 的格式没变）：

1. **服务商**：按厂商一张卡片（Anthropic、OpenAI、DeepSeek、Xiaomi MiMo）。每种接入方式一行：Anthropic 有"订阅 CLI"（`claude-cli`）和"API"（`anthropic`）两行，OpenAI 是"订阅 CLI"（`codex-cli`），DeepSeek / MiMo 是"API"。每行有自己的启用开关（可以同时开两行，路由按顺序当后备）、可用状态（可用 / 登录失败 / key 已配置 / 未配置 key / 冷却中……；网页进程看不到宿主机上的 CLI，所以在某次调用报登录错误之前，CLI 都显示"可用"）、模型、强模型、每日请求上限；超时、命令、接口地址等收在"更多设置"。已启用的行左边有绿条，卡片右上角的黄色标签写"当前用哪种方式、哪个模型"。卡片底部可折叠"模型目录"。
2. **路由与任务分配**：全局顺序（节点显示为"厂商 · 方式"，API 层内部顺序在旁边）；下面每个任务一行（打分、信号提取、翻译、摘要、建议、拆解、查薪资）：不改 = "沿用全局"，要自定义就给它排顺序并给每个节点选模型，"改为沿用全局"一键清空。
3. **限额与预算**：每轮条数 / 时间、冷却、订阅 CLI 的用量上限（每轮和滚动窗口内的调用数，只统计 Job Radar 自己的调用，见 [ai-providers.zh.md](ai-providers.zh.md)）、月 API 预算、超时、最大输出 token、自动翻译分数门槛。
4. **打分参数**：JD 截断、并发、批量、德语等级扣分，以及折叠的"预排序"。

### 预排序（`ai.yaml: scoring.priority`，）

不调用 AI 的快速预排序，决定等待打分的岗位谁先排队（每轮和"给未打分岗位打分"都用它）。表单分四组：**权重**（标题、薪酬信号、地点、级别、时效、德语差距，旁边显示六个权重之和，仅供参考，不要求等于 100）、**标题匹配**（关键词组系数、词都在标题里但不相邻的系数、部分匹配系数、不单独计分的通用词）、**级别匹配**（九种级别各 0–1）、**地点与时效**（想去的城市、周边、远程、只写国家、其他、地点不明各 0–1，地点不明的整体系数，时效天数）。改它只影响打分的先后，不影响分数。

## AI 标签：打分标准

AI 标签的打分区块里有**打分标准**（`ai.yaml: scoring.criteria`）：*最看重*、*不能接受*（命中的岗位压到 0–29 档）、*加分项*，每项一句话，
任何语言都可以，每个列表最多 10 项，每项最多 300 字。分数仍是一个 0–100 的总分；标准放进打分 prompt 的固定段落，和其他偏好一样随 JD
发给 AI。标准算进 prompt 版本（`score-v1+c<哈希>`）：改了以后，保存前页面会提示有多少条当前分数会重新打分；保存后这些分数标成过期，
在接下来几轮里逐步重打。清空标准就回到 `score-v1`。AI 写作用的语言在 `language.yaml` 里设（见 [languages.zh.md](languages.zh.md)），
改语言不会触发重打。

能写成规则的“不能接受”（岗位要求的语言等级高于你、JD 里的某个短语），更省钱的做法是在 我的画像 → 我要什么 里写成**一票否决项**：
它在硬过滤里、任何 AI 调用之前否决岗位，不花打分调用。见 [deal-breakers.zh.md](deal-breakers.zh.md)。

## AI 标签：理由来源

**理由来源**（`ai.yaml: scoring.evidence`，默认关闭）给详情页的每条匹配理由和差距标上**原文**（附 JD 原话，可跳到原文）、**推断**或**未提及**。
打开后每次打分多回答一些（输出 token 变多），引用长度由 `quote_max_chars`（默认 150）封顶，短于 `quote_min_chars`（默认 8，不计空格）的引用按推断处理。两项设置都不会触发重打；旧分数的理由照旧显示、没有来源。
见 [score-evidence.zh.md](score-evidence.zh.md)。

## AI 标签：下拉选择

- **provider 顺序**（`order`、`api_order`、各任务的 `tasks.<任务>.order`）是有序列表：上移 / 下移 / 移除，用"添加"下拉补回。可选值只有 `config/ai-options.ts` 里定义的 provider，`ai.yaml` 的 schema 也从这里取，不会两处不一致。
- **不可用标注**：顺序列表和添加下拉里，不能用的 provider 后面写着原因——未配置（API 没填 key，或宿主机报告找不到 CLI）、已关闭、登录失败（最近一次调用报登录错误，之后没有成功过）、冷却中、已达每日上限。数据和 `/sources` 的"AI provider 健康度"是同一份。
- **模型永远在服务商下面**：模型目录在 `config/models.yaml`（有哪些模型、单价、停用标记），设置页只选不改。每个服务商（厂商卡片里的一行）显示当前模型；"模型"（claude-cli / anthropic 还有"强模型"）是下拉，只列**这个服务商**目录里未停用的模型，选项文字是"显示名 · id"，API 的再加"· $输入 / $输出"（每百万 token）。当前值已停用：多一个"（已停用）"选项并选中，可以保存；当前值不在目录里：显示"（不在模型目录里）"，保存时字段下报错、文件不变。厂商卡片底部可折叠的"模型目录"是只读表（id / 显示名 / 单价 / codex 的推理强度 / 标记 / 备注，有 `docs_url` 时附官方模型列表链接）。**没有**"可选模型"标签框和"模型单价"一节。加新模型：`models.yaml` 是随产品发布的文件，先把 `config/models.yaml` 复制到 `data/config/models.yaml` 再改副本（文件开头有 5 步）。你的副本会整份替换发布的模型列表，之后产品对模型的更新要重新复制才会生效，约 5 秒后生效，刷新本页即可在下拉里看到；见 `ai-providers.zh.md` 的"新模型上线清单"。
- **顺序列表**：每一项后面用灰色小字标出它现在用的模型（`codex-cli · gpt-6.1-sol` / `· CLI 默认`，`api → deepseek, anthropic, mimo`，`api_order` 里是各自的默认模型），跟着草稿实时变。
- **任务分配**（区块 2）：每个任务一行，空 = 沿用全局顺序。每一行是"序号 · 服务商 · 模型下拉 · 上移 / 下移 / 移除"：模型下拉第一项是"默认 · <该服务商一节里选的模型>"（不指定），后面是这个服务商目录里的模型；`api` 这一项没有下拉（各 API 服务商用各自的默认模型）。先"添加…"服务商，再在同一行选它的模型；删掉服务商时它的模型一起删掉。保存后写成 `tasks.<任务>: {order: [...], models: {服务商: 模型}}`。
- **codex-cli**：模型下拉的空选项是"CLI 默认（<目录里标 cli_default 的显示名>）"（不写 `model` 键）；推理强度是下拉，只列当前选中的 codex 模型支持的强度（目录里 `reasoning_efforts`，没写 = 全部），当前值不被支持时多一个"（这个模型不支持）"选项，保存时报错；按任务的推理强度多一个"跟随默认"。
- **目录读不了**（`models.yaml` 缺失、YAML 写错、不过 schema）：AI 标签顶部红框"<实际读的 models.yaml 路径> 读不了：…"，模型下拉只显示当前值，点保存返回"模型目录读不了，先修好 models.yaml"，其他标签不受影响。
- 服务端保存时用同一个 schema 再校验，并对照目录：模型不在目录里、codex 推理强度不被模型支持、任务给不在自己顺序里的服务商选了模型、顺序里出现未知 provider，都会在对应字段下报错，文件不变。选中已停用的模型只标记，不阻止保存。

### 其余表单里的隐藏键

- **处理时间**：`suggest` 的开关、cron、Telegram 通知、回看几周、每次最多几条建议、最低把握；`linkedin_recommended`（LinkedIn 推荐页的开关和 cron）；`backup.max_age_hours`（doctor 的备份新鲜度）；`manual_triggers.min_interval_seconds`。`suggest` 里只决定 prompt 大小的键（哪些状态算喜欢 / 忽略、最多几条岗位、JD 字数、证据条数）和 `doctor`、`deploy` 留在"高级"。
- **拆解**：`jd_head_share` 是表单里的一个数字。
- **界面**：`ai_usage` 四项（默认范围、自定义范围最长天数、明细每页行数、CSV 最多行数）；"界面"标签下方另有 `insights.yaml` 一张表单（时间范围、单列城市、直方图分段）。

`ai.yaml` 片段：

```yaml
providers:
  claude_cli:
    model: claude-sonnet-5-5       # 必须是 models.yaml 里 claude-cli 下的模型
    strong_model: claude-sonnet-5-5
  codex_cli:
                                   # 不写 model 时用 CLI 默认（models.yaml 里标 cli_default 的那个）
    reasoning_effort: low          # 必须在所选模型的 reasoning_efforts 里（没写 = 不限）
    reasoning_effort_by_task: {}   # 例如 { translate: medium }
  deepseek:
    model: deepseek-flash          # models.yaml 里 deepseek 下的模型（带单价）
tasks:
  translate:
    order: [codex-cli, claude-cli, api]
    models: {claude-cli: claude-sonnet-5-5}   # 这个任务试到 claude-cli 时用 Sonnet；只能给本任务 order 里直接列出的服务商指定
```

`models.yaml` 片段（目录）：

```yaml
providers:
  deepseek:
    label: DeepSeek API
    models:
      - id: deepseek-flash
        label: DeepSeek V4.1 Flash
        price: { input_per_mtok: 0.3, output_per_mtok: 1.2 }   # API 服务商必填，订阅 CLI 不许写
```

## 界面标签：语言

"界面"标签最上面是**语言**区块，编辑 `language.yaml`：默认界面语言（给没选过语言的浏览器）、AI 写作用的语言和一句话摘要另附的语言、
JD 翻译成的语言、Telegram 和命令行的语言（选"跟界面默认语言一致"就是 `null`）。界面语言用各自的名字列出；AI 语言和翻译目标可以填任何
语言代码（`en`、`zh`、`de`、`pt-BR`），填错会在字段下提示并拒绝保存。runner 和 ai-worker 会重新加载这个文件（保存条显示 runner 是否已加载）；
网页每次打开页面都会读取。每个键的含义见 [languages.zh.md](languages.zh.md)。

## 界面标签：图形组件的刻度和轮数

"界面"标签编辑 `ui.yaml`（和下面的 `insights.yaml`）。这些值只影响显示（薪资轴、新鲜度条、趋势线、健康方块、跑马灯），不影响采集和打分。网页每次打开页面时重新读取；runner 不用它，所以保存条只写"网页直接读取，刷新即生效"，没有 runner 加载状态。

| 键 | 默认 | 含义 | 约束 |
|---|---|---|---|
| `salary_axis.min_k` | 40 | 薪资轴左端，千欧元 / 年 | 整数 ≥ 0 |
| `salary_axis.max_k` | 200 | 薪资轴右端，千欧元 / 年 | 整数，大于 `min_k` |
| `salary_axis.tick_step_k` | 20 | 刻度间隔，千欧元 | 正整数，小于整根轴（`max_k - min_k`） |
| `salary_stats.min_sample` | 5 | 详情页画薪资中位线和"高于 X% 已披露岗位"所需的本月写明薪资岗位数，少于它就不画 | 正整数，最大 1000 |
| `freshness.decay_hours` | 72 | 岗位首次发现后多少小时，新鲜度条缩到最短（最短是整条的 6%，不会消失） | 正整数 |
| `freshness.warn_hours` | 24 | 超过多少小时，新鲜度条变黄并带斜线纹理 | 正整数，小于 `decay_hours` |
| `trend_cycles` | 7 | 汇总块的趋势线取最近几轮 | 2 – 60 |
| `health_cycles` | 14 | 来源页每个通道的健康方块取最近几轮；不够的几轮画虚线空格 | 1 – 60 |
| `ticker_max_items` | 8 | 顶部跑马灯最多滚动几条 | 1 – 50 |

- 薪资轴里的红线（底线）来自 `data/profile/preferences.yaml: salary_floor_year`，红三角（分数电量格的推送线）来自 `notify.yaml: push_min_score`；它们不在 `ui.yaml` 里，改了会同时影响图形。
- 写明的区间超出轴的范围时，色块被截在轴的两端（轴本身不会自动伸缩）：要看到更高的薪资，把 `max_k` 调大。
- 保存时同一个 schema 再校验；错误写在对应字段下（最大值要大于最小值、刻度间隔要小于整根轴、变黄线要小于衰减小时数）。
- 图形组件的用法和示例见开发环境页 `/dev/viz`（生产环境 404）。
- 今日页和岗位页：汇总块的趋势取最近 `trend_cycles` 轮，跑马灯最多 `ticker_max_items` 条；表格的新鲜度条用 `freshness`，薪资迷你轴用 `salary_axis`；分数电量格的推送线是 `notify.yaml: push_min_score`，汇总块第三块的"≥ N 分"也是它。
- 岗位表格的"技能重合"拿岗位的技能（`jobs.skills`，`pipeline.yaml: skills` 的名字）和 `me.yaml` 的技能比对，忽略大小写、空格、连字符和单复数；同一个技能的其他写法写在 `pipeline.yaml: skills[].aliases`（例如 `k8s`、`Large Language Models`），只影响这一列，不影响打标签。岗位没有写技能时显示"—"，不是 0/0。
- "高于 N% 已披露岗位"：和本月（按首次发现时间、`schedule.yaml` 的时区）写明薪资的岗位比，按区间中点算（只写一端的用那一端），不含被硬过滤的、待核对的和可能是其他地区薪资的；样本少于 2 个时不显示百分位。

```yaml
salary_axis: { min_k: 40, max_k: 200, tick_step_k: 20 }
salary_stats: { min_sample: 5 }
freshness: { decay_hours: 72, warn_hours: 24 }
trend_cycles: 7
health_cycles: 14
ticker_max_items: 8
```

## 推送标签：Telegram

推送标签顶部的 Telegram 区块显示 bot 是否已配置：“已连接”“未连接”“不完整”（`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
只设了一个）或“值无效”；三个 `TELEGRAM_*` 变量哪些已设置（只显示名字，从不显示值）；推送是否打开；最近一次测试消息。
已连接时有测试按钮和修改用的命令；否则是一段简短的指引，附上要在宿主机上运行的命令 `pnpm run setup --step telegram` 和复制按钮。
网页不能填写或修改 token：见 [telegram.zh.md](telegram.zh.md#1-用一条命令配置)。设置向导的 Telegram 步骤显示同样的区块。

## 申请流程标签

隐藏不用的申请状态、调整超时天数、隐藏列表筛选里不用的分类，加上 `resume.yaml` 的简历工具表单。**状态是固定的**（这是固定的产品设计）：不能新增、改名，也不能隐藏"新"和"已忽略"；隐藏只影响显示。

- **状态表**：9 个状态各一行（名称、所在看板列、当前申请数、"显示"开关、超时天数）。只有"感兴趣"和"已申请"有超时天数，存在 `notify.yaml: reminders.interested_days / applied_days`（从推送标签搬到这里，推送标签留一行链接指过来）。状态表和分类共用一个保存按钮：`ui.yaml` 和 `notify.yaml` 都先校验，再依次写入；第二份没写成功时明确说是哪一份还是旧的。
- **隐藏的效果**：看板上没有卡片的隐藏状态不显示列；还有卡片的显示成折叠的窄列"面试中 · 已隐藏 · 2"（点开查看，不能把卡片拖进去，页头提示"N 张卡片在隐藏的状态里"）；"已结束"列里隐藏状态的投放区去掉；看板卡片菜单、抽屉、详情页的状态菜单不列隐藏的状态（卡片自己当前的状态照常列出，带"（已隐藏）"）；/jobs 筛选不列隐藏的状态和分类值，但链接或保存的视图里已经选中的照常生效；快捷键 `s` 的目标（感兴趣）被隐藏时不生效；Telegram 里目标状态被隐藏的按钮不显示；统计页漏斗不画隐藏且计数为 0 的阶段。服务器仍然接受改到隐藏状态的请求（旧页面、旧 Telegram 消息里的按钮）。
- **分类**：工作方式（现场 / 混合 / 远程）、合同类型（全职 / 固定期限 / Freelance / 劳务派遣 / 学生岗）可以勾选隐藏；"未知"不能隐藏。
- 键在 `ui.yaml`：`applications.hidden_statuses`、`filters.hidden_workplaces`、`filters.hidden_contracts`（都默认 `[]`）。`ui.yaml` 的 `config_version` 因此从 1 升到 2：`pnpm config:migrate --write` 插入 `applications` / `filters` / `config_editor` 三块并带注释；还没迁移的文件在内存里迁移后照常运行。

## 高级编辑器

`/settings?tab=advanced`：每份配置文件都能按原文编辑。左栏列出 `registry.ts` 里的全部配置文件（不含画像 me / preferences），分"用户配置"和"产品默认"（models、pipeline）两组，每行写文件名、来源（用户目录 / 默认 / 已覆盖默认）、是否合法（不合法时给第一条问题）、版本是否落后；新增的配置文件（例如 `traps.yaml`）自动出现。`?tab=advanced&file=pipeline` 直接打开某个文件（`file` 是文件名去掉 `.yaml`）。

- **编辑区**：带行号的等宽文本框（不是代码编辑器库）。Tab 缩进两格（Shift+Tab 反缩进，按 Esc 再按 Tab 离开输入框），⌘/Ctrl+S 打开"预览并保存"，出错的行号标红。
- **实时校验**：停止输入约 0.4 秒后在服务器上依次检查 YAML 语法、`config_version`（必须等于代码的版本）、zod schema、跨文件（`ai.yaml` 的模型对照 `models.yaml` 的目录，保存 `models.yaml` 时反过来查现有的 `ai.yaml`）。每个问题显示路径、原因和行:列，点一下光标跳到那一行；缺少的键定位到最近一层存在的父节点（标"最近的上级位置"）。有问题时"预览并保存"是灰的。
- **预览差异**：可以和"已保存的版本"比，也可以和"产品默认"比；顶部汇总改了哪些键路径；没有改动时显示"没有改动"。
- **保存**：服务器上重新校验，再按原文写入（注释和格式完全是你写的样子）。写之前把旧文本备份到 `<用户目录>/.backup/editor/<时间>/<文件>`，每个文件保留 `ui.yaml: config_editor.backups_keep` 份（默认 20）；文本最大 `config_editor.max_bytes`（默认 256 KiB）。写入是原子的，写完 runner 靠热加载生效，页面显示"runner 已加载 hh:mm"。
- **防止覆盖**：页面打开时记下文件的哈希和来源层。保存时哈希或来源层变了（被设置表单、来源清单、别的标签或手改动过）就拒绝，显示"你打开后文件被改过"和"打开时 → 现在"的差异，给「载入最新文件」（丢弃自己的改动）和「复制我的文本」两个按钮；不做自动合并。
- **产品默认文件**（models、pipeline）：编辑页顶部常驻黄色提示"保存会在用户目录生成整份覆盖文件，之后产品更新这个文件不会生效"；第一次保存要勾选确认。「恢复默认」备份后删除覆盖文件，重新从默认目录读取。**用户配置**的「恢复默认」用默认文件的内容替换当前文件，先备份，确认框里显示差异。
- **密钥**：`sources.yaml` 里 `jobspy.proxies` 的账号密码在编辑器、差异、列表里都显示成 `***:***@`；保存时按位置换回原值。代理地址和原来不同、增删代理都会被拒绝（"代理只能在文件里改"）。编辑区上方常驻提示"密钥放 .env，不要写进配置文件"；备份目录在 `data/` 下，不进 git。
- **受保护的键**：命令、API 地址和凭据路径（清单见 [configuration.zh.md](configuration.zh.md#受保护的键只能手动改)）列在编辑区上方；改动其中一个会在对应行显示"受保护的键"问题，保存按钮不可用。其他标签的表单里这些字段是只读的。请手动编辑文件来改。
- **修复入口**：某个文件不合法时，其他标签原来的"读不了"提示里有链接「在高级编辑器里修复 →」。高级编辑器不依赖任何配置能读：`ui.yaml` 坏了就用默认的上限。
- 保存是"后写的赢"：检查哈希和写入之间仍有一个很短的间隙，单用户场景下可以接受；表单保存也是读最新的再合并，所以表单先于编辑器保存时，编辑器一定会发现冲突。

## 拆解标签：岗位拆解

"拆解"标签（在"AI"之后）编辑 `data/config/breakdown.yaml`：开关与方式（`enabled`、`mode`：手动 / 自动）、自动拆解的门槛和每轮上限（`auto.min_rank`、`auto.per_cycle_limit`，只在方式为"自动"时生效）、请求（`jd_max_chars`、`timeout_seconds`，后者带"秒"）。`jd_head_share`（JD 截断时保留开头的比例）是请求里的一个数字。保存、"runner 已加载"确认和其他标签一样（runner 和 ai-worker 都监视这个文件）。默认关闭；用哪个 AI 在"AI"标签的任务覆盖里设（任务"拆解"，codex 还有"推理强度：拆解"）。详见 [`breakdown.md`](breakdown.md)。

AI 陷阱检测没有自己的标签：开关、模式和阈值直接改 `traps.yaml`（见 [ai-traps.zh.md](ai-traps.zh.md)）；用哪个 AI 在"AI"标签的任务覆盖里设（任务"AI 陷阱检查"，codex 还有"推理强度：AI 陷阱检查"）。

## 薪资标签：薪资水平和查薪资

"薪资"标签（在"拆解"之后）编辑 `data/config/salary.yaml`：基准（`benchmark.enabled`、`window_days`、`min_sample`）
和查薪资（`lookup.enabled`、`ttl_days`、`max_per_day`、`timeout_seconds`）。岗位族、薪资网站链接、
查询的域名清单和合理范围在 YAML 里改（"高级"标签）。查薪资默认关闭；由哪个 AI 来查，是 AI 标签里的任务"查薪资"（默认
claude-cli，然后 Anthropic API；只用能搜索网页的 provider，codex-cli 如果你加上，它搜索时没有域名限制）。见
[salary.zh.md](salary.zh.md)。

## 手动触发和测试

所有按钮都只在 `control_requests` 里留一个请求，由 runner（容器里）或 ai-worker（宿主机上）取走执行；页面每 2 秒问一次这个请求，结果直接显示在按钮下面。请求没结束时按钮是灰的；同一个目标的同类请求还没结束就直接复用，结束后 `schedule.yaml: manual_triggers.min_interval_seconds`（默认 30 秒）内再点会被拒绝并提示还要等几秒。每次创建请求，web 日志里有一行 `manual request queued`（日志级别为 `info` 或 `debug` 时，见 [`configuration.zh.md`](configuration.zh.md) 的“日志级别”）。没有固定的等待时限：请求排队时，按钮下面显示处理它的进程前面还有几个请求、正在做什么（以及开始时间）；请求在跑时，显示它自己的开始时间和已进行的时长。进程在不在按心跳判断（ai-worker 用 `ai.yaml: host_worker.offline_after_seconds`，runner 用 `RUNNER_HEARTBEAT_SECONDS`）：没有新的心跳时，按钮下会提示 ai-worker（或 runner）离线，附 `/sources` 链接，并继续等；进程回来后请求照常执行。临时读不到状态或返回的排队信息无效时，页面保留上次的等待状态，下一次轮询重试；请求进入终态才停止轮询，但采集请求由正在运行的轮次覆盖时，页面会继续跟踪进度，直到那一轮结束。哪个进程处理哪种请求，由 `ai.yaml: execution` 决定。翻译、拆解、查薪资和岗位页的“立即打分”也一样。进程在线、请求却长时间停在“处理中”，多半是卡在了某次 provider 调用上：到 `/sources` 看 ai-worker 日志。打分请求到了时间预算停下时，请求列表里显示“到了时间预算”和还剩多少条。

| 按钮 | 位置 | 请求 | 谁执行 | 做什么 |
|---|---|---|---|---|
| 立即跑一轮 | `/settings?tab=actions` 手动操作 | `run_cycle` | runner | 一个手动轮，可以只勾选部分通道 |
| 立即采集 | `/sources` 通道卡片 | `run_cycle`（只带这个通道） | runner | 这个通道跑一轮完整采集（写入岗位，计入预算）。未完成的请求只有覆盖这个通道时才复用（它采全部通道，或者包含这个通道；LinkedIn 级联里靠后的来源，只有级联以它打头的请求才算）；别的通道的请求在跑时，这次另建一个请求，排在它后面执行。runner 领取时如果正在运行的一轮已经覆盖这个通道（采全部通道的定时轮次），请求立即记为完成，按钮跟着那一轮显示进度（“由正在运行的第 … 轮覆盖”）直到它结束；正在运行的是别的通道的一轮时，以"另一轮正在运行"失败 |
| 测试 | `/sources` 通道卡片 | `test_channel` | runner | 只跑第一个查询（ATS 类是整板扫描），最多取 `sources.yaml: test_channel.max_results` 条（默认 5），在内存里解析，显示抓到 / 解析成功的条数和前几条标题；**不写**岗位、原文、运行记录、用量和熔断状态。有一轮正在跑、通道已关闭、未配置、本月预算用完时不测。`test_channel.excluded_kinds`（默认 `paid`、`session`）里的通道没有测试按钮：付费通道按条计费，LinkedIn 登录态有每日页数上限，请用"立即采集"。超过 `timeout_seconds`（默认 120）记为 `timeout`。发现类通道（tavily、brave）不抓岗位：测试最多发 `test_channel.max_queries`（默认 1）次搜索，成功即显示"抓到 0 条"（接口可用），发现的 board 不保存，所用额度不计入本月用量 |
| 测试 | `/sources` AI provider 健康度 | `test_ai` | ai-worker（`execution: container` 时是 runner） | 和 `pnpm ai:probe` 一样的极小请求，走正常路由但只试这一个 provider：已关闭、冷却中、到每日上限、缺 key、API 月预算用完都会直接拒绝。计入当天请求数和健康记录，用量记在 `ai_usage`（任务名 `probe`，`/sources` 的 AI 用量里显示为"测试"）。结果显示实际模型、耗时和 token |
| 发送 Telegram 测试消息 | `/settings?tab=actions` 手动操作 | `test_telegram` | runner | 点击后要再点一次"发送"确认；即使 `notify.yaml: telegram.enabled` 还是 false 也会发，用来确认 bot token 和 chat id |

失败时按钮下显示原因和一个错误码（例如 `network`、`blocked`、`auth`），不显示原始错误文本；详情看 runner / ai-worker 的日志（`channel test failed`、`ai provider test failed`、`telegram test message failed`）。

### 部署后

新的请求类型要求 runner 和 ai-worker 都是新代码：数据库迁移（`0018`）由 runner 启动时自动执行；`scripts/ops/deploy.sh` 的第 10 步会重启 ai-worker。没用 `deploy.sh`（或带了 `--no-ai-worker`）时要手动重启一次（`launchctl kickstart -k gui/$(id -u)/io.jobradar.ai-worker`，或重跑 `scripts/ops/install-ai-worker.sh`），否则 AI 测试会一直排队。`ai.yaml` 新增的 `tasks.<任务>.models` 随代码一起更新；升级到带模型目录的版本时：先升级代码（`models.yaml` 新增、`ai.yaml` 只改注释，旧代码不受影响），再在项目目录运行 `pnpm models:migrate --dry-run`、`pnpm models:migrate`、`pnpm config:check`；之后才能往 `tasks.*.models` 里写。旧代码遇到新文件、或新代码遇到旧文件，热加载都会忽略无效配置并保留上一份。

### 调参

```yaml
# sources.yaml
test_channel:
  max_results: 5
  max_queries: 1             # 发现类通道（tavily、brave）最多几次搜索
  timeout_seconds: 120
  excluded_kinds: [paid, session]

# schedule.yaml
manual_triggers:
  min_interval_seconds: 30   # 0 = 不限
```

## 保存条、时间芯片和离开提醒

- 标签页在页面顶部（分段式），手动操作卡片在配置表单下面。
- 保存条在 `/settings`、`/me`、`/interests` 都浮在视口底部（手机上也是）；没有改动时"保存"和"还原"是灰的。
- cron 输入框旁边的灰色芯片是只读的解释（"工作日 07:00"）；输入框仍然是可编辑的原文。时间轴也画出已关闭的轮次：虚线框、灰字加删除线。
- 数字框里的单位（小时、毫秒、k€ …）来自键名，写在框里，不用再看标签。
- 有未保存的改动时点侧栏链接或命令面板里的页面，会弹出"留下 / 放弃改动"；刷新或关闭标签页用浏览器自带的提示。浏览器的后退按钮不拦截。
- 保存时只改动你改过的部分：文件里原来的 `{ a: 1 }` / `[a, b]` 写法保持不变，schema 默认值产生的空列表（`exclude: []`）不会被写进文件。


部署期间，认识冻结协议的 web 版本从第 4 步起拒绝设置、高级编辑器、个人资料和向导保存，并显示正在升级。首次部署本版本时，旧 web 运行到第 8 步，仍写无害的旧格式文件。请稍后重试；遗留冻结的恢复方法见 [upgrade.zh.md](upgrade.zh.md#升级期间的设置)。
