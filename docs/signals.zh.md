# 信号类别：薪酬、福利和自定义信号

处理轮里的 `signals` 步骤和 `ai` 步骤下的 `signals` 子任务，把 JD 里的薪酬信号挑出来，每个都附原文引用。类别、词表、权重和上限都在用户配置目录的 `interests.yaml`。

/interests 最近岗位预览和 AI 重审成本估算不含休眠岗位。规则扫描、薪资同步和加分对账也跳过它们；醒来后由下一轮补齐，旧结果仍在显式状态视图中可见。

## 信号类别

信号分成**类别**，在 `/interests` 页上可以新增、删除、改名、排序（最多 12 个），也可以直接改 `interests.yaml` 的 `signals.categories`。列表顺序就是显示和排序的顺序。每个类别有一种类型：

| 类型 | 作用 | 说明 |
|---|---|---|
| `amount` | 写明的金额 | 用正则找金额，换算成年薪，和薪资底线比较。最多一个。金额参数在 `amount:` 下（只能在 YAML 里改） |
| `keyword` | 关键词 | `keywords`（字面词）、`patterns`（正则）、`exclude`（排除项）；AI 会复核 |
| `tag` | 福利式标签 | `tags`（字面词）、`tag_patterns`（名称 + 正则）；只靠规则，不交给 AI |

每个类别还有：`id`（字母开头，最多 24 个字符，保存后不能改，`kind` 也不能改）、`label`（`zh` / `en`，至少一种）、`icon`（最多 2 个字）、`color`（调色板：amber、teal、coral、blue、olive、violet、slate、pink、neutral）、`weight`（命中时加的分）、`high_value`（高价值信号，见下）、`ai_confirm_only`（规则命中只作候选，AI 确认后才算；`tag` 类不能用）、`ai_definition`（给 AI 的英文定义）。

默认的五个类别就是原来的档位，id 不变：

| id | 类型 | 内容 | 徽章 | 默认加分 | 高价值 |
|---|---|---|---|---|---|
| T1 | amount | 写明的具体金额（换算成年薪） | 💰 €85–105k | 10 | 是 |
| T2 | keyword | 股权、期权、员工持股 | 📈 股权 | 8 | 是 |
| T3 | keyword | "有竞争力的薪资"这类定性描述 | 🏅 有竞争力 | 3 | 否 |
| T4 | keyword | 奖金、13. Gehalt、利润分成（要 AI 确认） | 🎁 奖金 | 2 | 否 |
| tag | tag | Deutschlandticket、JobRad、≥ 28 天假期… | 小标签 | 0 | 否 |

排序值 = 匹配分 + min(各类别加分之和, `bonus_cap`)；同一类别在一个岗位上只算一次；`tag` 类只有权重大于 0 时才加分。金额类只有在"写明的金额算高薪"时才加分：年薪上限（市场的基准货币，其他货币按 `amount.rough_fx` 的粗略汇率折算，两张表都没有的币种无法比较、按高薪处理）要不低于 `amount.bonus_requires_at_least`（`salary_floor` = `preferences.yaml` 的 `salary_floor_year`，默认；数字 = 每年至少这么多基准货币；`none` = 写明金额就算）。低于门槛的金额照样提取和显示，但徽章是灰色的、不加分，也不算高价值信号。"可能是其他地区的薪资"（见下）的金额改加 `amount.other_region_weight` 分（默认 0：不加分、不算高价值信号）；同一岗位还有本地金额时按本地的算。改了权重、`bonus_cap` 或薪资底线，保存后立刻重算 `scores.signal_bonus` 和 `rank_value`，不需要 AI。

### 高价值信号

勾选了 `high_value` 的类别算高价值信号（默认 T1 和 T2）。它们决定：列表的"只看高价值信号"（URL 参数 `high=true`；旧链接的 `t12=true` 仍然可用，按 `high=true` 读）、推送的低门槛（`notify.yaml` 的 `push_min_score_high_value`）、今日页"合格"的口径、统计页的高价值信号数。金额类还要达到薪资底线、并且是本地薪资。没有任何高价值类别时，这个按钮不显示，推送只用 `push_min_score`。

### 改了什么会重新扫描或复核

- 改名称、图标、颜色、权重、高价值：不重扫、不重新送 AI，加分立刻重算。
- 改词表、正则、排除项、`ai_confirm_only`、类别的顺序，新增或删除类别：下一轮重新扫描 JD（规则指纹变了）。
- 改 AI 定义、增删 amount / keyword 类别、改 `ai_confirm_only`：AI prompt 的版本变化，在架岗位在后面几轮按每轮上限重新复核。默认五个类别的 prompt 和升级前逐字相同（版本仍是 `signals-v1`）。

### 删除和恢复

删除的类别移到 `signals.retired_categories`（保留完整定义）。它的信号留在数据库里，但不显示、不加分、不参与筛选和推送；删除前的确认框会写明已存多少条信号、涉及多少个岗位。"已删除的类别"可以恢复，恢复后下一轮重新提取。删除过的 id 不能给新类别用。

### 从旧格式升级

`interests.yaml` 和 `notify.yaml` 的格式版本是 2。旧文件（版本 1，`signals.T1..T4`、`benefit_tags`、`weights`）在加载时自动在内存里转换，照常运行；`pnpm config:migrate` 先预览改动，`pnpm config:migrate --write` 备份后写回（注释保留）。转换后五个默认类别和原来的档位完全一样，升级后不会全量重扫，也不会全量重新送 AI。

## 添加你自己的兴趣点

例子：你想知道哪些雇主给大量或无限量的 AI token 预算，或者给员工付 Copilot / Claude / Cursor 的席位费。这就是一个
`keyword` 类的信号类别，不需要新东西。

**用类别还是评分标准？** 类别会出徽标（带 JD 原文引用），能筛选，按 `weight` 给排序值加分，设了 `high_value` 还会用更低的
推送门槛。`ai.yaml: scoring.criteria.nice_to_have`（见 [settings.zh.md](settings.zh.md)）里写一句话只会轻微影响 AI 匹配分：
没有徽标、不能筛选，而且一改就要重打全部分数。想看到、想筛选的用类别；模糊的偏好用 `nice_to_have`。

**一步步来**

1. `/interests` → **新增类别** → **从这里开始**：选预设“AI 工具 / token 预算”（或“开源时间”），或者选“空白类别”再选
   种类“关键词”。预设会填好名称、图标、颜色、权重、AI 定义和词表（英文加你市场的本地语言，德国包是德文）。预设在随产品
   发布的 `config/signal-presets.yaml` 里，选它只是填表。id 被占用时会自动加 `_2`。
2. 用英文写 **AI 定义**，写清什么算、什么不算：
   `The employer pays for AI tools for the employee ... Not: building AI products, or "experience with AI tools" asked of the candidate.`
3. 可选：**词和正则**，你的岗位用几种语言写就各写一遍（规则不会翻译）。它们不花 AI 就能找出候选；`exclude` 用来排除
   “experience with Copilot”这类说法。
4. **权重**（分数，受封顶限制）和**高价值信号**。
5. **在最近的岗位上试试**：用词和正则扫一遍最新的 `limits.preview_jobs` 个在架岗位（默认 500），显示命中了几个岗位和最多
   三条原文样例，以及保存后约多少个岗位会重新送 AI 审核、按每轮上限约需几轮。不调用 AI，不保存任何东西。检查最多跑
   `limits.preview_time_budget_ms`（默认 1500 毫秒），超时就把结果标为部分结果。
6. **保存**。保存后的提示会再给一次重审估算。

**怎么匹配。** 规则层用词表找候选（不花 AI）。AI 审核每个未被过滤的在架岗位时，按每个类别的定义读 JD：确认或否决候选，
并补上词表漏掉的说法，JD 用什么语言都行。**只写定义、不写词**的类别也能用：`limits.ai_review_without_candidates: true`
（默认）时，没有规则候选的岗位也会送 AI，AI 按语义找它；类别行会显示“只靠 AI”。这个设置关掉时，这样的类别永远不会命中：
类别行显示警告，`pnpm config:check` 输出 `interests.semantic_only_unreachable`。每条信号都必须带 JD 里真实存在的原文引用，
不是原文的引用会被丢弃。

**什么时候生效，花多少。** 新增 keyword 类别会改变 AI 提示词版本：从下一轮起，在架岗位按 `ai.yaml: per_cycle_limit` 每轮
分批重新审核；被过滤和已关闭的岗位不审。大致是接下来几轮里每个在架岗位一次 AI 调用。只改词（不改定义）只会重新扫描 JD，
不用 AI。

**同一个类别写成 YAML**（`interests.yaml` 的 `signals.categories` 下）：

```yaml
- id: ai_tools_budget
  kind: keyword
  label: { en: AI tools / token budget, zh: AI 工具 / token 预算 }
  icon: 🤖
  color: violet
  weight: 4
  high_value: false
  ai_confirm_only: false
  ai_definition: >-
    The employer pays for AI tools for the employee: a large or unlimited AI / LLM token or usage budget, company-paid
    licences or seats for AI assistants (GitHub Copilot, Cursor, Claude, ChatGPT, Gemini), or an explicit budget for AI
    tools. Not: building AI products, AI as a research topic, or "experience with AI tools" asked of the candidate.
  keywords: [unlimited tokens, AI budget, AI tools budget, Copilot license, KI-Budget, unbegrenzte Tokens]
  patterns:
    - '\b(?:unlimited|generous|large|uncapped)\s+(?:AI\s+|LLM\s+)?(?:token|usage|credits?)\b'
    - '\b(?:access|licen[cs]es?|seats?|subscriptions?)\s+(?:to|for)\s+(?:[\w-]+\s+){0,3}?(?:Copilot|Cursor|Claude|ChatGPT|Gemini)\b'
  exclude:
    - '\bexperience\s+(?:with|in|using)\s+(?:[\w-]+\s+){0,3}?(?:Copilot|Cursor|Claude|ChatGPT|Gemini)\b'
```

词表太宽会抓到不想要的：打开 `ai_confirm_only`，规则命中要等 AI 确认才算信号。

## 两步提取

1. 规则（每轮，不花 AI）：用各类别的词表在 JD 里找候选，取命中处所在的句子做引用（最长 `limits.quote_max_chars`，每个类别最多 `limits.per_category_max` 条）。金额用 `pipeline.yaml` 的 `salary` 段换算成年薪（月薪×12 等），年薪低于 `amount.min_annual` 的丢弃。`ai_confirm_only` 类别（默认 T4）的命中只是候选，要 AI 确认才成为信号。
2. AI（`ai` 步骤，`tasks.signals` 可单独指定 provider 顺序）：对每个还没复核过的岗位（有候选的先，每轮最多 `per_cycle_limit` 条，已被硬过滤的不送），AI 按各类别的 `ai_definition` 确认或否定每个候选、补上词表漏掉的说法、读出金额的数字和周期。**代码**再检查：类别必须是当前的 amount / keyword 类别，引用必须是 JD 的子串（只允许空白差异，存的是 JD 自己的文本），金额的数字必须出现在引用里，换算由代码做。不合格的丢弃。

JD 或词表变了会重新扫描（只替换当前启用类别的信号）；已复核的岗位在 JD 和 prompt 版本不变时不会再送 AI。

## 岗位自带的薪资 → 金额类

岗位的归一薪资（`jobs.salary_json`，来源：渠道的结构化字段 > 渠道的薪资文字 > JD 正文里的薪资句）只要可信（`qualityStatus = valid`、有币种和周期、年薪不低于 `amount.min_annual`）就生成一条金额信号（没有金额类别时不生成），不论 JD 正文里有没有同样的金额：

- 来自渠道字段或渠道薪资文字的，引用就是那段字段原文（例如 LinkedIn 的 `€75,000.00/yr - €100,000.00/yr`），`signals.quote_source = structured`，没有 JD 偏移；详情页标"来源字段"。来自 JD 正文的，引用是 JD 里的原句，`quote_source = description`。
- 加分照旧只看"年薪上限 ≥ 薪资底线"（区间碰到底线也算）。
- JD 里规则找到的金额如果落在这条薪资的区间内、或和别的金额相同，就并掉；金额不同的（如 OTE）保留。
- 薪资变了（解析改进、数据源更新），金额信号随之更新，**不**重扫 JD、**不**重新送 AI（`signal_scans.salary_hash` 记录它依据的薪资）。

## 薪资怎么从文字里读

`pipeline.yaml` 的 `salary` 段：

- 区间两端都带单位也能读（`€75,000/yr - €100,000/yr`、`75k p.a. – 100k p.a.`、`EUR 75k–100k`）。
- JD 正文里的金额必须：有币种、`description_context_patterns` 里的薪资词在 `context_window_chars` 以内、且 `negative_context_patterns`（relocation、allowance、learning budget、phone、vacation、funding ……）里的词没有比薪资词离金额更近（`negative_context_window_chars`）。"Relocation support: up to €2,500"、"€60/month phone allowance" 因此不会变成薪资。金额类的规则命中同样检查"福利词更近"。
- `plausible_per_period`：写明的金额（按周期，不是年化）不在范围内就标 `AMOUNT_IMPLAUSIBLE_FOR_PERIOD`（待复核）；JD 正文里读出的待复核薪资不存。
- 解析规则变了（`SALARY_PARSER_VERSION`）或 `salary` 段变了，`pipeline` 步骤会用当前解析重读所有岗位的原始帖子、修正已存的薪资，每次变更只做一次。手动：`pnpm reprocess`（原文放回待处理并重跑 `pipeline` → 薪资 → 硬过滤 → 规则信号 → 薪资信号同步 → 加分 → 德语复核，不采集、不花 AI；选项 `--channel <id>` 只重处理指定通道的原文；对副本库用，见 [extraction.zh.md](extraction.zh.md#重新处理已入库的岗位)）。

## 词表怎么写

- `keywords`：字面词，整词、不区分大小写。
- `patterns`：正则（`iu` 标志），用于变形和组合说法（德语词尾、"competitive … salary"）。
- `exclude`：某个命中的起点落在这些匹配里（命中范围之内，或之前 `limits.exclude_lookbehind_chars` 个字符以内）就丢弃——例如 "diversity, equity and inclusion" 不是股权，"bonus of €25,000" 里的金额不是薪资。
- `amount.assume_currency`（金额类）：金额没写币种、同一句里有薪资词时按这个币种处理，并在详情页标注；设为 `null` 则丢弃这类金额。
- 其他货币的金额保留原币种，同时按 `pipeline.yaml: salary.fx_pivot` + `fx_rates` 的参考汇率给出市场基准货币的年薪（没有汇率的币种不折算）；薪资底线、"最低年薪"筛选、统计页和金额类的门槛都用这个基准货币年薪（见 [market-packs.zh.md](market-packs.zh.md)）。
- 时薪、日薪、月薪按 `salary.periods_per_year`（时 2080、日 260、月 12）换算成年薪；JD 正文里"带币种、写明时/日/周/月周期"的单个金额（"Rate: 18 USD per hour"）没有薪资词也算薪资，所以照样过薪资底线。

## 可能是其他地区的薪资

币种不在 `pipeline.yaml: salary.local_currencies`（默认 `[EUR]`）里，或 JD 里出现 `salary.other_region_patterns` 的说法（"our US benefits"、"rates vary per country"、"pay range … in the US"），这笔薪资和它的金额信号就标"可能是其他地区的薪资"（`salary_json.otherRegion`、金额信号 `value_json.otherRegion` = `currency` / `description`）。它照样折成 EUR 年薪、照样过薪资底线；列表徽章变灰并写"可能非本地"，详情页写明原因和 EUR 折算，Telegram 的 💰 后面加"（可能是其他地区的薪资）"。

改 `fx_rates`、`local_currencies`、`other_region_patterns` 或 `other_region_weight` **不会**重扫 JD、不会重新送 AI：下一轮的 `signals` 步骤把已存的金额按新设置重算一遍（`revalueSignals`，每次变更只做一次），加分随之更新。

## 看板

- 岗位行：每个类别一个徽章或标签（类别的颜色和名称；金额类显示金额）。
- 详情页"薪酬与福利"：每个信号的类别、归一值、加分、原文引用和来源（规则 / AI）；加分合计与封顶；标签类别的标签；JD 原文和译文里引用的句子按类别的颜色高亮。
- 详情页（v3）：标题区右侧是排序值卡（20 格电量格 + 匹配分/加分堆叠条，封顶取 `interests.yaml: bonus_cap`）和年薪卡（薪资轴：红线是 `preferences.yaml: salary_floor_year`，虚线是本月写明薪资岗位的中位数（/me 底线预览和 /insights 用同一个定义，各自标明范围和个数；其他地区和待复核的薪资不进中位数），下面是"高于 X% 已披露岗位"）。本月样本少于 `ui.yaml: salary_stats.min_sample`（默认 5）时不画中位线和百分位，写明样本不足。"薪酬与福利"每条信号一行，底部封顶条把各类别叠起来、超过封顶的部分画斜线；点信号标签会切到 JD 原文、滚到对应句子并闪烁（只有 JD 里真有这句话的信号才有跳转，没有就只显示引用）。"条件核对"：德语 A1–C2 阶梯（你 / 要求 / 差距；岗位写"不需要"或没写时只画你的等级并写明，不推测）、技能重合（`me.yaml` 的技能和岗位技能忽略大小写，并用 `pipeline.yaml: skills` 的 aliases 当别名，比如你写 k8s 能对上 Kubernetes；画像里一条写了几个技能，如"LLM / RAG"或"Kubernetes (k8s)"，会拆开各算一个，列表页用同一套规则）、薪资底线 ✓ / ✕（写明的上限对底线）。
- 列表（今日、全部岗位）：快速筛选"只看高价值信号"（URL 参数 `high=true`，按钮提示里列出当前的高价值类别）。

## 命令

```bash
# 在真实岗位上跑一遍（用数据库副本：会写 signals 和 scores）
DATABASE_URL=postgres://…/jobradar_copy pnpm smoke:signals --jobs 37,51,7
```
