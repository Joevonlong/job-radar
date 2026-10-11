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
| `pack.yaml` | `id`（= 目录名）、`name`，以及市场默认值：`country`、`currency`、`language`、`locale`（地名的大小写规则）、`region`（本国所在的命名区域）、`default_channels`（本市场的招聘渠道：向导里带"本地"标记列出，/me 上可以"开启它们"；StepStone、XING 这类抓取渠道不会未经你确认就被它打开，见 [sources.zh.md](sources.zh.md#抓取)）。 |
| `geography.yaml` | `countries`（代码、英文名、可选的 `currency`（设置向导选这个国家时建议的货币）、`aliases`、`indeed` 名、可选 `pattern`、名字是常用词时 `match: false`）、`regions`（名称、国家、`patterns`）、`cities`（写法 → 规范名 + 国家）、`subdivision_codes`（`US: [TX, NY, …]`）、`non_city_labels`、`non_city_words`、`city_aliases`、`metro_areas`、`metro_regions`、`country_level_patterns`、`transliterations`。 |
| `language.yaml` | 各语言的 `stopwords`（判断正文语言）和 `requirement`：读取要求等级的规则（`word_pattern`、`cefr_name_pattern`、`cefr_connectors`、`level_rules`、`optional_patterns`、`not_required_patterns` ……，以及给打分提示词的 `prompt_examples`）。 |
| `rules.yaml` | pipeline.yaml 里和语言有关的部分：`company.legal_suffixes` / `agency_names`、`agency.*_patterns`、`contract.*`、`salary.currencies`（货币的写法）、`filter.generic_location_patterns`、`filter.remote.*`；`closed_posting.phrases`：原帖页面上表示"不再接收申请"的句子（正则，不区分大小写；只接受 configuration.zh.md"关注岗位复查"一节说的安全子集：不允许 `*`、`+`、`{n,}`），收藏 / 跟进岗位的复查用（见 usage.zh.md"已关闭的岗位"）。 |

`generic` 包总是加载：世界国家表、区域 `eu`、`eea`、`europe`、`dach`、`nordics`、城市表、美国州代码和英文规则。市场自己的包叠加在它上面。

## 生效的 pipeline 配置怎么合成

代码把 `pipeline.yaml` 和市场包一起读（`loadPipeline()`）：

- 列表：先是你 pipeline.yaml 里的条目，然后 generic，再然后市场包，去重；
- map（`city_aliases`、`metro_areas` ……）：同一个键以你的为准；
- `language.requirement`：整块来自市场包（规则顺序有意义）；你在 pipeline.yaml 里写了 `language.requirement` 就用你的；
- `salary.local_currencies`：不写 = 市场的货币；
- `closed_posting.phrases`：generic 和市场包的列表合并；你自己的短语写在 `ui.yaml` 的 `job_checks.closed_recheck.extra_phrases`，不写在 pipeline.yaml。

所以 pipeline.yaml 只需要放你自己加的内容。pipeline.yaml 的配置迁移已经删掉了现在由包提供的条目。

## 写一个新包

1. 把 `config/packs/de/` 复制到 `data/config/packs/<id>/`，改 `pack.yaml` 的 `id`、`name`、`country`、`currency`、`language`、
   `locale`、`region`、`default_channels`。
2. `geography.yaml`：本国的都市圈、只写国家的说法、来源会去掉的字母的转写。国家和区域来自 `generic`，只有表里没有的国家才在这里加。
3. `language.yaml`：这门语言的停用词；想要本地语言步骤，再写 `requirement` 块，不写这一步就保持关闭。
4. `rules.yaml`：公司法律形式后缀、中介和合同用语、货币写法，以及这门语言里"不再接收申请"的句子（`closed_posting.phrases`；
   写得具体些：命中会把岗位标为可能已关闭）。
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
