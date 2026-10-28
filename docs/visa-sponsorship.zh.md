# 签证赞助

[English](visa-sponsorship.md) | [中文](visa-sponsorship.zh.md)

Job Radar 读出每条 JD 里关于签证赞助或工作许可的说法，并用 JD 原话展示。它只用规则（不调用 AI，不花 token），不改变任何分数、排序或推送。

自动扫描和统计数字不含休眠岗位；显式指定岗位 id 仍可检查，已有签证证据仍在详情页保留。

## 德国 JD 里的"签证赞助"是什么意思

德国没有英国那样的雇主担保名单。非欧盟候选人通常自己申请欧盟蓝卡或工作签证，雇主提供合同，有时帮忙办手续或搬家。所以德国 JD 说"提供签证赞助"，多半是指帮忙办材料或 relocation；JD 什么都没写，也不代表雇主拒绝。因此这项检查最有用的是反方向的信号：明确拒绝赞助的 JD，或要求你**已经**持有工作许可的 JD。

## 四种结果

| 结果 | JD 怎么说 | 例子 |
| --- | --- | --- |
| `offered` | 提到签证、蓝卡、工作许可或搬迁方面的支持 | "We offer visa sponsorship and relocation support" |
| `not_offered` | 拒绝赞助（`no_sponsorship`），或要求已经持有工作许可（`permit_required`） | "We are unable to offer visa sponsorship"；"You must hold a valid work permit for Germany" |
| `unclear` | 提到签证，但规则判断不了，或者两种说法都有 | "Questions about visas and relocation? Ask us"；"…or are eligible for an EU Blue Card" |
| `not_mentioned` | 没提签证 | — |

页面上写的是"提到签证或搬迁支持"，不写"提供赞助"：提到不等于承诺。除 `not_mentioned` 外，每个结果最多保留三段引文，都是 JD 原文片段，带位置。

## 在哪里看到

列表上显不显示，取决于**关于我 → 需要雇主提供签证担保**（`me.yaml: needs_visa_sponsorship`）和 `ui.yaml: job_checks.visa.badges`：

| `badges` | 需要赞助 | 不需要 |
| --- | --- | --- |
| `auto`（默认） | 徽标和筛选 | 都不显示 |
| `always` | 徽标和筛选 | 徽标和筛选 |
| `never` | 都不显示 | 都不显示 |

- **列表徽标**：`offered` 显示绿色"提到签证支持"；`not_offered` 显示红色虚线框"不提供签证"或"要求已有工作许可"。`unclear` 和 `not_mentioned` 不显示徽标。
- **筛选**（/jobs、筛选条、保存的视图、手机的筛选抽屉）：**提到支持**（`visa=offered`）只显示 `offered` 的岗位；**去掉明确不提供的**（`visa=not_denied`）显示除 `not_offered` 外的所有岗位，还没检查的岗位和 `unclear` 的岗位都留着：可能行的岗位，宁可看到也不要藏起来。
- **筛选隐藏时**（检查关闭、`never`、或 `auto` 且你不需要赞助），URL 或保存的视图里的 `visa=` **忽略但保留**：不筛任何东西，不出筛选条，不计数，"清除"也不删它。保存的视图里还在，筛选重新出现时又生效。
- **岗位详情页**：检查开着时，检查卡片里总有一行"签证赞助"，写结果、引文和**在原文中查看**，点了跳到 JD 里的那段话（虚线下划线）。只有需要赞助的用户才看到颜色（`not_offered` 红、`offered` 绿），否则是灰色。

`needs_visa_sponsorship` 只留在你自己的机器上：只用来决定页面显示什么，从不发给 AI 或其他服务。

## 怎么读一条 JD

JD 先切成小段：句子、列表项，以及短标题行和它的下一行合成的一段。标题行指不超过 `heading_max_chars` 个字符、并且以":"结尾、以"#"开头（markdown），或者是一个没有句末标点的短语的行："Visa sponsorship:" / "Not available"，"## Visa sponsorship" / "Not available for this role."。标题下面紧跟列表或另一个标题时，标题单独成段；列表项把引出列表的那一行（标题，或任何以":"结尾的行）当作上下文。每段单独判断：

1. 讲别的事的段落跳过：支付卡（"Visa/Mastercard"）、"sponsored events"、"Sponsoring von Veranstaltungen"，以及雇主自己的产品或客户（"We help our customers with visa applications"、"You will support our immigration team"、"Wir unterstützen Unternehmen bei der Relocation"）。
2. "提供"类说法带否定词（"not"、"no"、"none"、"unable"、"without"、"nicht"、"nein"、"kein…"、"leider" 等）时算 `unclear`，绝不算 `offered`。否定词出现在说法里面、说法前 `negation_words_before` 个词内（"We do not offer relocation support"），或说法后同一分句的 `negation_words_after` 个词内（"Relocation support is not available"、"Relocation support: No"、"Relocation-Support bieten wir nicht an"）都算。分句在";"、破折号、"but"、"however"、"aber"、"jedoch" 等处结束，所以 "We offer visa sponsorship, but no signing bonus" 仍算 `offered`。引出列表的那一行里有否定词时，对列表的每一项都算："What we can't offer:" / "- Visa sponsorship" 算 `unclear`，"What we offer:" / "- Visa sponsorship" 算 `offered`。
3. 列表里只有一个名词（"- Visa sponsorship"、"- Visa-Unterstützung"）只在它自己是一个列表项时算 `offered`，当标题时不算。
4. "要求工作许可"后面紧跟替代办法（"…or are eligible for an EU Blue Card"、"bei Bedarf unterstützen wir"），算 `unclear`，不算拒绝。
5. 同一段里既拒绝又提供，算 `unclear`。
6. 签证词和语境词同时出现（"visa" + "relocation"、"Visum" + "unterstützen"），又没有更明确的说法，算一次不明确的提及。单独一个 "Visa" 不算。
7. 关于签证的标题，下一行带否定词（"Visa sponsorship" / "We can't help with this."），只要不是拒绝说法就算 `unclear`；否定标题下的列表（第 2 条）也一样。

整条 JD 的结果：既有 `offered` 段又有 `not_offered` 段，算 `unclear`（两边都引用）；否则 `not_offered`；再否则 `offered`，但有第 7 条那种说"不"的标题时算 `unclear`；再否则 `unclear`；都没有就是 `not_mentioned`。公司名本身是签证词时（比如 Visa Inc.），只算把这个词和语境连在一起的说法。

AI 陷阱检测找出的隐藏文字（[ai-traps.zh.md](ai-traps.zh.md)）不算。

英文说法所有市场都有；德文说法随德国市场提供。这些说法写在市场包里（[market-packs.zh.md](market-packs.zh.md#签证说法)）。

## 什么时候运行

每轮 `signals` 步骤在 AI 陷阱扫描之后运行这项检查。只有 JD、公司、隐藏文字或规则变了，岗位才会重新检查；每轮最多 `pipeline.yaml: job_checks.visa.per_cycle_limit` 个（从没检查过的优先，新的优先）。出错时这一步记为"部分完成"，下一轮重试。

更新前收进来的岗位，或改了规则之后：

```bash
pnpm visa:scan                  # 预览：会改什么，不写入
pnpm visa:scan --write          # 写入结果（再跑一次会报告 0 处变化）
pnpm visa:scan --job 1234       # 只查这一个岗位，结果是新的也重新查
pnpm visa:scan --limit 500 --json
pnpm visa:scan --text jd.txt    # 用一个文本文件试规则，不需要数据库
```

## 设置

`ui.yaml`（你自己的）：

```yaml
job_checks:
  visa:
    enabled: true   # false：什么都不检查，页面也不显示
    badges: auto    # auto | always | never（列表徽标和 /jobs 筛选）
```

`pipeline.yaml`（随产品提供），见 [configuration.zh.md](configuration.zh.md#签证检查pipelineyaml--uiyaml)：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `job_checks.visa.per_cycle_limit` | 2000 | 每轮最多检查的岗位数 |
| `job_checks.visa.max_quotes` | 3 | 每个岗位保留的引文数（最多 10） |
| `job_checks.visa.quote_max_chars` | 280 | 引文最长字数；句子更长时围绕关键说法截取 |
| `job_checks.visa.negation_words_before` | 6 | "提供"类说法前面查否定词的词数 |
| `job_checks.visa.negation_words_after` | 5 | 说法后面、同一分句内查否定词的词数 |
| `job_checks.visa.heading_max_chars` | 60 | 算作标题、和下一行合读的最长行 |

## 作为一票否决

想隐藏拒绝赞助的岗位，在**我的画像 → 我要什么 → 一票否决项**里加一条签证规则（**添加签证规则**）（[deal-breakers.zh.md](deal-breakers.zh.md#不提供签证)）：

```yaml
deal_breakers:
  - id: visa
    label: No visa sponsorship
    type: visa_not_offered
```

它只否决 `not_offered` 的岗位（两种都算）；`unclear` 和 `not_mentioned` 的岗位放过。`needs_visa_sponsorship` 为 false 时它不起作用，`pnpm config:check` 会提醒。

过滤步骤在 `signals` 之前运行，所以这条规则当场用同样的规则读 JD，但**包括**隐藏文字：新岗位还没有陷阱扫描结果，读上一次的结果会让同一个岗位在几轮之间来回变。极少数情况下拒绝赞助的话藏在白字里，规则会否决这个岗位，详情页却写 `not_mentioned`。

## 它不做什么

- 不判断你需要哪种签证、够不够条件（蓝卡薪资门槛之类），不读移民法或担保名单。
- 不改变分数、排序、发给 AI 打分的内容和 Telegram 消息。
- 只读英文和德文；其他语言的 JD 除非用了英文说法，否则是 `not_mentioned`。

## 回滚到旧版本之前

旧版本不认 `ui.yaml` 里的 `job_checks.visa`，也不认 `preferences.yaml` 里的 `visa_not_offered` 规则。回滚前，从 `ui.yaml` 删掉 `job_checks.visa`（如果 `job_checks` 里没有你改过的别的内容，可以整块删掉），并删掉 `deal_breakers` 里的 `visa_not_offered` 规则。`job_visa` 表可以留着：旧版本不读它。
