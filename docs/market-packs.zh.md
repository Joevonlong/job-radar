# 市场包

[English](market-packs.md) | [中文](market-packs.zh.md)

Job Radar 在一个**市场**里工作：你找工作的那个国家。市场决定地点怎么识别、哪些远程岗位在范围内、从岗位里读哪门本地语言的要求、
薪资用哪种货币比较，以及跑哪些招聘渠道。背后的数据（国家、区域、城市、规则用语）放在**市场包**里，不写在代码里。

## 选择市场

`data/profile/preferences.yaml`：

```yaml
market:
  pack: de            # config/packs/ 下的目录名
  # country: DE       # 所在国家（ISO 3166-1），默认取包的
  # currency: EUR     # 基准货币（ISO 4217），默认取包的
  # home_language: de # 本地语言（ISO 639），默认取包的
```

个人资料页（/me）"我要什么"顶部的**市场**区块编辑的就是它。`generic` 包不指定国家、货币和语言，用它时三项都要写
（`pack: generic, country: US, currency: USD, home_language: en`）。读不出来的市场（包不存在、包文件有错、缺值）在页面上保存不了；
手改文件写错时，所有和市场有关的步骤都会停下，直到改好（不会悄悄退回别的市场）。

查看当前生效的市场：

```bash
pnpm market:show        # 市场包、国家、货币、语言步骤开 / 关、本市场的渠道
pnpm config:check       # 校验所有市场包和 preferences.yaml 的市场
pnpm run doctor --only config.market
```

## 跟着市场走的部分

| 方面 | 行为 |
|---|---|
| 地点 | 写出国家的地点得到该国代码（`Remote - USA` → US，`Dublin, CA` → US）。本国国名前面的城市（`Gütersloh, Germany`）只在本国市场下读取。 |
| 远程范围 | preferences.yaml 和 search.yaml 里写 `none`、`home_country`、`worldwide` 或 `{region: [eu, CH, …]}`（命名区域和 ISO 国家）。旧值：`eu_hire_in_de` = `home_country`，`eu_any` = `{region: [eu]}`。 |
| 本地语言 | 包里有该语言的要求规则、并且 `home_language` 就是这门语言时，才读岗位要求的等级；高于你在 me.yaml `languages` 里的等级会扣分（ai.yaml `scoring.language_penalty`）。否则这一步关闭：不读等级、不扣分、打分提示词不问这一项，页面也隐藏相关筛选和标签。 |
| 基准货币 | 薪资底线、"最低年薪"筛选、统计和高薪门槛都用市场的货币。其他货币按 pipeline.yaml 的 `salary.fx_pivot` + `fx_rates` 换算；没有汇率的货币不参与比较。 |
| 渠道 | sources.yaml 里写了 `markets: [DE]` 的渠道只在这些市场运行；在别的市场下折叠在"其他市场"里，不算失败。国家参数留空（`country`、`country_name`、`country_indeed`）、远程地点不写的键，都跟随市场。 |

换市场后，新岗位立刻按新市场处理；已入库的岗位要运行 `pnpm reprocess` 才会重新判断。

## 包的结构

一个包就是一个目录 `config/packs/<id>/`（随产品发布）。`data/config/packs/<id>/` 里的副本整包替换发布的那份（之后产品对这个包的更新
不会生效，`pnpm run doctor` 会提醒）。只有 `pack.yaml` 是必需的。

| 文件 | 内容 |
|---|---|
| `pack.yaml` | `id`（= 目录名）、`name`，以及市场默认值：`country`、`currency`、`language`、`locale`（地名的大小写规则）、`region`（本国所在的命名区域）、`default_channels`（本市场的招聘渠道：向导里带"本地"标记列出，/me 上可以"开启它们"；StepStone、XING 这类抓取渠道不会未经你确认就被它打开，见 [sources.zh.md](sources.zh.md#抓取)；`de` 包列的是 arbeitsagentur、stepstone、xing 和 [arbeitnow](sources.zh.md#arbeitnow)）。 |
| `geography.yaml` | `countries`（代码、英文名、可选的 `currency`（设置向导选这个国家时建议的货币）、`aliases`、`indeed` 名、可选 `pattern`、名字是常用词时 `match: false`）、`regions`（名称、国家、`patterns`）、`cities`（写法 → 规范名 + 国家）、`subdivision_codes`（`US: [TX, NY, …]`）、`non_city_labels`、`non_city_words`、`city_aliases`、`metro_areas`、`metro_regions`、`country_level_patterns`、`transliterations`。 |
| `language.yaml` | 各语言的 `stopwords`（判断正文语言）和 `requirement`：读取要求等级的规则（`word_pattern`、`cefr_name_pattern`、`cefr_connectors`、`level_rules`、`optional_patterns`、`not_required_patterns` ……，以及给打分提示词的 `prompt_examples`）。 |
| `rules.yaml` | pipeline.yaml 里和语言有关的部分：`company.legal_suffixes` / `agency_names`、`agency.*_patterns`、`contract.*`、`salary.currencies`（货币的写法）、`filter.generic_location_patterns`、`filter.remote.*`；`closed_posting.phrases`：原帖页面上表示"不再接收申请"的句子（正则，不区分大小写；只接受 configuration.zh.md"关注岗位复查"一节说的安全子集：不允许 `*`、`+`、`{n,}`），收藏 / 跟进岗位的复查用（见 usage.zh.md"已关闭的岗位"）；`ghost`：招聘帖背后可能没有真实空缺的迹象（见[幽灵岗位说法](#幽灵岗位说法)）；`visa`：JD 里关于签证赞助的说法（见[签证说法](#签证说法)）。 |

`generic` 包总是加载：世界国家表、区域 `eu`、`eea`、`europe`、`dach`、`nordics`、城市表、美国州代码和英文规则。市场自己的包叠加在它上面。

## 生效的 pipeline 配置怎么合成

代码把 `pipeline.yaml` 和市场包一起读（`loadPipeline()`）：

- 列表：先是你 pipeline.yaml 里的条目，然后 generic，再然后市场包，去重；
- map（`city_aliases`、`metro_areas` ……）：同一个键以你的为准；
- `language.requirement`：整块来自市场包（规则顺序有意义）；你在 pipeline.yaml 里写了 `language.requirement` 就用你的；
- `salary.local_currencies`：不写 = 市场的货币；
- `closed_posting.phrases`：generic 和市场包的列表合并；你自己的短语写在 `ui.yaml` 的 `job_checks.closed_recheck.extra_phrases`，不写在 pipeline.yaml。
- `ghost` 和 `visa`：generic 和市场包的列表合并（generic 在前）；pipeline.yaml 里没有它们自己的说法。

所以 pipeline.yaml 只需要放你自己加的内容。pipeline.yaml 的配置迁移已经删掉了现在由包提供的条目。

## 幽灵岗位说法

`rules.yaml` 的 `ghost` 一节是[幽灵岗位检查](ghost-jobs.zh.md)用的说法。`generic` 放英文，`de` 放德文。带 `id`（小写字母、数字和 `_`）的条目把 id 存进原因里，检查卡和 `pnpm ghost:check` 能说出是哪条说法命中的。

| 键 | 是什么 |
|---|---|
| `repost_label_patterns` | 来源自己的"重新发布"标签（"Reposted 2 weeks ago"、"Wiedereingestellt"）；`{id, pattern}` |
| `evergreen_patterns` | JD 写明是人才库或常年招聘（"for our talent pool"、"always hiring"、"Initiativbewerbung (m/w/d)"）；`{id, pattern, check_negation}`。`check_negation: false` 表示说法本身就是否定（"no specific opening"、"keine konkrete Stelle"） |
| `responsibility_patterns` | 职责段落的标题（"Responsibilities"、"What you'll do"、"Deine Aufgaben"），只对像标题的行测试；`{id, pattern}` |
| `negation_cues` | 让人才库说法不算的词：在说法里面、说法前 `pipeline.yaml job_checks.ghost.negation_words_before` 个词内、说法后同一分句 `negation_words_after` 个词内，或在所在列表的标题里 |
| `clause_breaks` | 分句在哪里结束（";"、" but "、" aber "、"and we …"） |
| `exclude_context` | 匹配到的句子（或紧挨在它前面的问句）不算：雇主的产品或客户、岗位职责、真实招聘帖的结尾、条件句、隐私说明 |
| `abbreviations` | 句点不表示句子结束的缩写 |
| `prefilter` | 快速初筛：没有命中的 JD 或行不再找人才库说法 |

和签证一样，**`evergreen_patterns` 能匹配到的每个说法都必须包含一个 `prefilter` 命中**，否则永远看不到；`pnpm config:check` 会对正则文本里没有 prefilter 匹配的说法给出警告，写错的正则会指出路径（`ghost.evergreen_patterns[2]`）。改了说法之后，接下来几轮会把所有岗位重新检查一遍；可以先用 `pnpm ghost:check` 预览。

## 签证说法

`rules.yaml` 的 `visa` 一节是[签证检查](visa-sponsorship.zh.md)用的说法。`generic` 放英文，`de` 放德文；德国市场两者都用。

| 键 | 是什么 |
|---|---|
| `offered` | 提到支持（"We offer visa sponsorship"、"Relocation-Support"） |
| `not_offered.no_sponsorship` | 拒绝赞助（"We are unable to offer visa sponsorship"） |
| `not_offered.permit_required` | 要求已经持有工作许可（"You must hold a valid work permit"） |
| `permit_alternatives` | 紧跟在 `permit_required` 说法旁边的替代办法，让这句变成不明确（"…or are eligible for an EU Blue Card"） |
| `mention_terms`、`mention_context` | 同一句里有签证词又有语境词，算一次不明确的提及 |
| `negation_cues` | 让 `offered` 说法变成不明确的词（"not"、"kein…"）：出现在说法里面、说法前 `pipeline.yaml job_checks.visa.negation_words_before` 个词内，或说法后同一分句的 `negation_words_after` 个词内 |
| `clause_breaks` | 上面那个分句在哪里结束（"; "、" but "、" aber "）：之后的否定词不算。逗号和冒号不结束分句（"Relocation support: No"） |
| `exclude_context` | 匹配到的句子不是在讲求职者的签证（"sponsored events"、"Visa/Mastercard"、"our customers with visa applications"） |
| `exclude_companies` | 本身就是签证词的公司名（规范化后）：对这些公司只算标了 `combo: true` 的说法 |
| `abbreviations` | 点号不表示句子结束的缩写（"z.B"、"inkl"） |
| `prefilter` | 快速初筛，见下 |

`offered`、`not_offered.*` 和 `mention_terms` 的条目是 `{pattern, combo, list_item}`：`combo: true` 表示这个说法把签证词和语境连在一起，
所以对名字是签证词的公司也算；`list_item: true` 表示只在它自己是一个列表项时才算（单独的名词 "- Visa sponsorship"），当标题时不算（"## Visa sponsorship" 下一行 "Not available"）。说法是带 `iu` 标志的正则；写错时 `pnpm config:check` 会指出路径（`visa.offered[3]`）。

**`prefilter`**：签证一票否决每轮过滤都要读所有未关闭的岗位，所以一段文字或一句话如果不匹配任何 prefilter，就直接跳过，
不再跑其他说法。前提是 **`offered`、`not_offered` 或 `mention_terms` 能匹配的每个说法里都含有一个 prefilter 匹配**：
加了一个带新关键词的说法（"Aufenthaltstitel"），也要把这个词加进 `prefilter`，否则永远看不到。只有含 prefilter 匹配的行（连同它上面的标题）才切成句子。
`pnpm config:check` 会对正则文本里没有 prefilter 匹配的说法给出警告（粗略检查：看的是正则本身，不是它能匹配的内容）。`prefilter` 留空就逐句读（更慢）。

改了说法之后，`pnpm visa:scan` 预览会改什么，`pnpm visa:scan --write` 写入；规则是每个结果输入的一部分，所以每轮也会把所有岗位重新检查一遍。

## 写一个新包

1. 把 `config/packs/de/` 复制到 `data/config/packs/<id>/`，改 `pack.yaml` 的 `id`、`name`、`country`、`currency`、`language`、
   `locale`、`region`、`default_channels`。
2. `geography.yaml`：本国的都市圈、只写国家的说法、来源会去掉的字母的转写。国家和区域来自 `generic`，只有表里没有的国家才在这里加。
3. `language.yaml`：这门语言的停用词；想要本地语言步骤，再写 `requirement` 块，不写这一步就保持关闭。
4. `rules.yaml`：公司法律形式后缀、中介和合同用语、货币写法，以及这门语言里"不再接收申请"的句子（`closed_posting.phrases`；
   写得具体些：命中会把岗位标为可能已关闭）。
   这门语言的签证说法写在 `visa` 下（见[签证说法](#签证说法)），幽灵岗位说法写在 `ghost` 下（见[幽灵岗位说法](#幽灵岗位说法)）；没有的话只读英文说法。
5. 把 `market.pack` 设成 `<id>`，运行 `pnpm config:check`、`pnpm market:show`，再 `pnpm reprocess`。
6. 想看改了什么：之前运行 `pnpm market:regress snapshot --out before.json`，reprocess 之后同样存一份 `after.json`，
   再 `pnpm market:regress compare before.json after.json`。它只输出各字段的变化数量和代码值的变化（国家、等级、过滤原因），不输出岗位文字。

## 数据库列名对照

列名保持不变，含义改成"市场的本地语言"：

| 列 | 含义 |
|---|---|
| `jobs.german_level_required` | 岗位要求的本地语言等级（`none`、`preferred`、`A1`…`C2`、`unknown`） |
| `scores.german_penalty` | 因本地语言扣的分 |
| `scores.german_level`、`german_level_ai`、`german_level_source` | 扣分用的等级、AI 读出的等级、怎么定下来的 |

`jobs.salary_json` 和 T1 信号里的薪资带 `basePerYear` + `baseCurrency`；基准货币一直是 EUR 时写的旧行按 EUR 读取。

## 改名的配置键

配置迁移（`pnpm config:migrate --write`）会改名；改之前旧文件在内存里照常可用。

| 文件 | 之前 | 现在 |
|---|---|---|
| preferences.yaml | `salary_floor_eur_year` | `salary_floor_year`，并新增 `market` |
| preferences.yaml、search.yaml | `remote_scope: eu_hire_in_de / eu_any` | `home_country` / `{region: [eu]}` |
| sources.yaml | `remote_locations.eu_hire_in_de / eu_any` | `home_country` / `region`；德国的招聘网站加 `markets: [DE]` |
| pipeline.yaml | `language.german_*`、`salary.fx_to_eur` | DE 包的 `requirement`；`salary.fx_pivot: EUR` + `fx_rates` |
| ai.yaml | `scoring.german_penalty`、`priority.weights.german_gap` | `language_penalty`、`language_gap` |
| insights.yaml | `salary_bucket_eur`、`salary_bucket_cap_eur` | `salary_bucket`、`salary_bucket_cap` |
| interests.yaml | 金额类别的 `amount.min_annual_eur`、`amount.rough_fx_to_eur`；保存视图的 `filters.hideGerman` | `amount.min_annual`、`amount.rough_fx`（基准货币）；`filters.hideLang` |

`amount.assume_currency`（金额没写币种时按哪种货币算）可以写 `market`：市场的基准货币。/jobs 和今日页的 URL 用 `hideLang`；
带 `hideGerman` 的旧链接照常可用。
