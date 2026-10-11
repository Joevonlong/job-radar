# 一票否决项

[English](deal-breakers.md) | [中文](deal-breakers.zh.md)

一票否决项是你自己写的规则，在任何 AI 调用之前否决岗位，例如“岗位要求的德语高于我的水平”“JD 写明 100% on-site”。
规则写在 `preferences.yaml` 的 `deal_breakers` 下，在 **我的画像 → 我要什么 → 一票否决项** 里编辑，也可以手改 `data/profile/preferences.yaml`。

它们在硬过滤里执行，和薪资底线、黑名单在一起。被否决的岗位不花 AI 调用，因为只有通过硬过滤的岗位才会打分。

## 被否决的岗位会怎样

- 岗位**不会删除**。它和其他被过滤的岗位一样不出现在列表里，打开**显示已过滤**能看到，原因写“一票否决：<名字>”，
  一票否决的原因排在最前面。
- 岗位页写明是哪条规则否决的，并引用规则命中的 JD 原句。语言门槛还会写出两边的等级（“规则读到：C1；你的等级：B1”），
  方便你发现规则读错的情况。
- 在岗位页点**仍然保留**就留下这个岗位：之后会正常打分，原因仍然记着。这个选择按岗位生效，不按规则。
- 加规则之前已经打过分的岗位保留原来的分数，在**显示已过滤**里照常显示。只改一票否决项不会让任何分数过期：
  下一轮过滤对所有未关闭的岗位原地套用新规则；删掉规则后，它否决的岗位直接恢复，不用重新打分。
- 被否决的岗位不打分，也不推送到 Telegram。

## 写规则

每条规则有 `id`（小写字母、数字、`-` 和 `_`，记在每个被否决的岗位上）、`label`（列表里显示的名字，最多 60 字）、
`enabled`（默认 `true`）和 `type`。类型有两种。

### 语言门槛

```yaml
deal_breakers:
  - id: language-gate
    label: 德语要求高于我的水平
    type: language_gate
```

门槛读的是岗位**要求**的市场本地语言等级：收录岗位时 pipeline 自己的规则从正文读出的 CEFR 等级。它从不使用 AI 的读数，
所以一个岗位打分前后得到的结果一样。

- 不写 `at_least` 时，阈值是你在**关于我**（`me.yaml: languages`）里的等级：要求高于你的等级就否决。关于我没写这门语言时，
  岗位写了任何等级都会否决。
- 写了 `at_least: C1`，阈值固定：要求 C1 及以上就否决，不读关于我。
- “加分项”“不要求”“没写”一律不否决：岗位没写明的事从不把它过滤掉。
- 门槛只管市场的本地语言（德国市场即德语）。没有本地语言步骤的市场没有可读的等级：这条规则不生效，`pnpm config:check` 会给出警告。

你在关于我里改了等级，下一轮过滤会更新所有未关闭的岗位。

### 短语

```yaml
deal_breakers:
  - id: onsite-only
    label: 100% 坐班
    type: phrase
    patterns: ['100\s?%\s*(?:on-?site|vor Ort)']
    scope: description
  - id: rust
    label: Rust 岗位
    type: phrase
    terms: [Rust]
    scope: title
```

- `terms`：整词或短语。不区分大小写和重音（`Munchen` 能命中 `München`，`ss` 能命中 `ß`），只按整词命中：`Rust` 不会命中 “trust”。
- `patterns`：正则表达式，不区分大小写。`\b`（词边界）只认 a–z、数字和 `_`：`\bÜberstunden` 不会命中 “bezahlte Überstunden”。要整词匹配时优先用
  `terms`，它认识所有字母。
- `scope`：`title`、`description` 或 `any`（默认）。
- `unless`：正则表达式；命中所在的句子匹配其中之一时，这次命中不算。

```yaml
  - id: travel
    label: 出差多
    type: phrase
    terms: [travel]
    unless: ['\bno travel\b', 'travel (?:is )?not required']
```

它会否决 “Frequent travel to clients”，不会否决 “No travel required”。

出差超过 50% 暂时没有专门的类型。下面的正则在德语和英语 JD 上能近似做到：

```yaml
  - id: travel-over-50
    label: 出差超过 50%
    type: phrase
    patterns:
      - 'Reisetätigkeit.{0,30}(?:[5-9]\d|100)\s?%'
      - 'travel.{0,30}(?:[5-9]\d|100)\s?%'
```

它命中 “Reisetätigkeit von bis zu 60 %” 和 “travel up to 75%”，不命中 “Reisetätigkeit ca. 20 %” 和 “travel 10% of the time”。

### 上限

你写的正则每轮过滤都要在所有未关闭的岗位上跑一遍，而 JavaScript 正则本身没有超时，所以有三处限制它能用的时间：

- **保存时。** 回溯严重的写法会被拒绝，并说明原因：重复里套重复（`(a+)+`、`(\w*)*`）；两段以上不限长度的宽字符匹配
  （`.*x.*y`、`\d+.*\d+`、`\w+\s*\w+`；请改成有上限的写法，例如 `.{0,40}`）；以不限长度的 `.*` 开头（去掉即可，模式本来就在
  任意位置匹配）；重复分组的几个分支开头可能相同（`(a|ab)+`）。每个正则还会在几段长测试文本上试跑（与 `match_text_max_chars`
  一样长、没有匹配的一行），任何一段超过 `match_ms` 也会被拒绝。手改文件后，`pnpm config:check` 做同样的检查。
- **过滤时。** 在测试文本上太慢的规则不参与过滤。每条规则在一轮过滤里最多用 `rule_budget_ms`，用完后本轮剩下的岗位不再跑这条
  规则。这条规则没判到的岗位保留它之前给出的否决，所以机器忙时被否决的岗位也不会放行。两种情况都会以 `too_slow` 出现在过滤步骤的
  结果（`dealBreakerWarnings`）里，该步骤在运行记录里显示为部分完成，runner 日志会写出规则名。
- **页面上。** 卡片上的预览最多跑 `preview_ms`，到时会说明只算了多少个岗位；岗位页解释否决原因最多用 `match_ms`，超时就不显示引文。

`pipeline.yaml: filter.deal_breakers` 里的上限：

| 键 | 默认值 | 限制什么 |
| --- | --- | --- |
| `max_rules` | 20 | 生效的规则条数（最多 50） |
| `max_pattern_chars` | 200 | 单个词或正则的长度（最多 500） |
| `match_text_max_chars` | 20000 | 正文读取的字符数 |
| `rule_warn_ms` | 200 | `pnpm deal-breakers:check` 对在全部未关闭岗位上超过这个耗时的规则给出警告 |
| `match_ms` | 100 | 一个正则在一段测试文本上的耗时，以及岗位页上的解释 |
| `rule_budget_ms` | 2000 | 一条规则在一轮过滤或一次预览里的总耗时 |
| `preview_ms` | 3000 | 卡片上整个预览的耗时 |

超过 `max_rules` 和 `max_pattern_chars` 的规则保存时会被拒绝。

## 检查规则

卡片上每条规则下面显示它会否决库里多少个未关闭的岗位，并给出 3 个样例。命令行得到的是同一个数字：

```bash
pnpm deal-breakers:check              # 所有规则：数量、耗时、样例
pnpm deal-breakers:check --id travel  # 只看一条
pnpm deal-breakers:check --limit 50 --json
```

它不写任何东西。每条规则都会打印在全部未关闭岗位上的耗时，超过 `pipeline.yaml: filter.deal_breakers.rule_warn_ms`（默认 200 ms）
时给出警告：慢的正则会拖慢每一轮过滤。

## 规则写不了的条件

需要判断的条件（“我不喜欢的公司文化”）写不成规则。把它写到**设置 → AI → 打分标准**的“不能接受”里：AI 打分时会读到，
命中的岗位压到 0–29 档（见 [settings.zh.md](settings.zh.md#ai-标签打分标准)）。这样每个岗位仍要花一次打分调用。

## 回滚到旧版本之前

没有一票否决项的旧版本不认识 `deal_breakers` 键，会拒绝带这个键的 `preferences.yaml`。**回滚到旧版本前先删掉 `deal_breakers` 键。**
其他都不用撤销：没有数据库变更，已经记在被否决岗位上的原因会原样显示。
