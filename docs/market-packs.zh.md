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
| 远程范围 | 由 preferences.yaml 的 `places` 得出：远程岗可以在本国，以及每个列出的国家、区域或城市（✈ 和仅远程都算）；列了“全球”就在哪里都行。写明包里 `region`（德国包：EU、Europe、EMEA、EEA）的标签也算，不管还列了什么，所以 `[DE, CH]` 仍保留 `Remote - EU`。评分提示词把它写成 `home_country`、`worldwide` 或 `{region: [eu, CH, …]}`，显示为“能从德国远程（含面向欧盟 / 欧洲 / EMEA / 全球的远程岗）”；没有 `region` 的市场显示“能从某国远程”。旧值：`eu_hire_in_de` = `home_country`，`eu_any` = `{region: [eu]}`。逐行的结果见 [远程岗和关注公司](usage.zh.md#远程岗和关注公司)。 |
| 本地语言 | 包里有该语言的要求规则、并且 `home_language` 就是这门语言时，才读岗位要求的等级；高于你在 me.yaml `languages` 里的等级会扣分（ai.yaml `scoring.language_penalty`）。否则这一步关闭：不读等级、不扣分、打分提示词不问这一项，页面也隐藏相关筛选和标签。 |
| 基准货币 | 薪资底线、"最低年薪"筛选、统计和高薪门槛都用市场的货币。其他货币按 pipeline.yaml 的 `salary.fx_pivot` + `fx_rates` 换算；没有汇率的货币不参与比较。 |
| 渠道 | sources.yaml 里写了 `markets: [DE]` 的渠道只在这些市场运行；在别的市场下折叠在"其他市场"里，不算失败。国家参数留空（`country`、`country_name`、`country_indeed`）、远程地点不写的键，都跟随市场。 |

换市场后，新岗位立刻按新市场处理；已入库的岗位要运行 `pnpm reprocess` 才会重新判断。

## 包的结构

一个包就是一个目录 `config/packs/<id>/`（随产品发布）。`data/config/packs/<id>/` 里的副本整包替换发布的那份（之后产品对这个包的更新
不会生效，`pnpm run doctor` 会提醒）。包不是[叠加层](configuration.zh.md#你的文件是一个叠加层)：这是唯一仍然整体替换的地方。只有 `pack.yaml` 是必需的。你的 `data/config/pipeline.yaml` 里的列表替换出厂 `pipeline.yaml` 的列表，结果再和包取并集。

| 文件 | 内容 |
|---|---|
| `pack.yaml` | `id`（= 目录名）、`name`，以及市场默认值：`country`、`currency`、`language`、`locale`（地名的大小写规则）、`region`（本国所在的命名区域）、`default_channels`（本市场的招聘渠道：向导里带"本地"标记列出，/me 上可以"开启它们"；StepStone、XING 这类抓取渠道不会未经你确认就被它打开，见 [sources.zh.md](sources.zh.md#抓取)；`de` 包列的是 arbeitsagentur、stepstone、xing、[arbeitnow](sources.zh.md#arbeitnow) 和 [berlinstartupjobs](sources.zh.md#berlin-startup-jobs)；[handpicked](sources.zh.md#handpicked-berlin)（柏林、慕尼黑、汉堡岗位索引）也是 `de` 的渠道，但默认关闭、不在这里列出，因为该站没有公开条款）。 |
| `geography.yaml` | `countries`（代码、英文名、可选的 `currency`（设置向导选这个国家时建议的货币）、`aliases`、`indeed` 名、可选 `pattern`、名字是常用词时 `match: false`）、`regions`（名称、国家、`patterns`）、`cities`（写法 → 规范名 + 国家）、`subdivision_codes`（`US: [TX, NY, …]`）、`non_city_labels`、`non_city_words`、`city_aliases`、`metro_areas`、`metro_regions`、`country_level_patterns`、`transliterations`。 |
| `language.yaml` | 各语言的 `stopwords`（判断正文语言）和 `requirement`：读取要求等级的规则（`word_pattern`、`cefr_name_pattern`、`cefr_connectors`、`level_rules`、`optional_patterns`、`not_required_patterns` ……，以及给打分提示词的 `prompt_examples`）。 |
| `rules.yaml` | pipeline.yaml 里和语言有关的部分：`company.legal_suffixes` / `agency_names`、`agency.*_patterns`、`contract.*`、`salary.currencies`（货币的写法）、`filter.generic_location_patterns`、`filter.remote.*`；`closed_posting.phrases`：原帖页面上表示"不再接收申请"的句子（正则，不区分大小写；只接受 configuration.zh.md"关注岗位复查"一节说的安全子集：不允许 `*`、`+`、`{n,}`），收藏 / 跟进岗位的复查用（见 usage.zh.md"已关闭的岗位"）；`ghost`：招聘帖背后可能没有真实空缺的迹象（见[幽灵岗位说法](#幽灵岗位说法)）；`visa`：JD 里关于签证赞助的说法（见[签证说法](#签证说法)）。 |

`generic` 包总是加载：世界国家表、区域 `eu`、`eea`、`europe`、`dach`、`nordics`、城市表、美国州代码和英文规则。市场自己的包叠加在它上面。

## 地名怎么读

过滤、排序、城市分组、“查看岗位”链接和 handpicked 通道用同一个查找来读地名。一个地名可以是 Worldwide、区域、国家或城市；既是国家又是城市的名字（Singapore），地名查找本身按国家读，而过滤、排序、城市分组、“查看岗位”链接和 handpicked 通道先读城市表，把它当城市。

- **市场表里的任何写法都算同一个城市。** `cities` 表为每种写法给出规范名和国家，所以 `Munich`、`München`、`Muenchen` 是同一个城市，不论你在地点里填哪一个、岗位用哪一个。
- **你的 `city_aliases` 加入这个城市，不会把它拆开。** 你为某个规范名列出的写法，会并入市场表里同一城市的写法（`Hanover` 加别名 `Hannover City`，仍能匹配 `Hannover` 的岗位），显示的是你的规范名。`metro_areas`、`metro_regions` 的键也这样读，所以 `Koeln: [Hürth]` 对 `Cologne` 偏好生效。
- **不同的城市保持不同。** 原样写法永远优先。重音和大小写不用来区分城市（`Münster` 与 `Munster` 是同一个键），只有变音写法（`ae`、`oe`、`ue` 对应 `ä`、`ö`、`ü`）是后备，而且只在只指向一个城市时才用，所以表里同时有 `Au` 和 `Aue` 时，两者不会互相匹配。
- 表里都没有的名字不算错误：它只匹配它自己。

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
| `evergreen_patterns` | JD 写明是人才库或常年招聘（"for our talent pool"、"always hiring"、"Initiativbewerbung (m/w/d)"）；`{id, pattern, check_negation, negation_after, requires_context, only_before_duties}`。`check_negation: false` 表示说法本身就是否定（"no specific opening"、"keine konkrete Stelle"）；`negation_after` 覆盖这一条所在包的设置；`requires_context`（正则列表）表示命中所在的句子还要匹配其中一条才算（"join our AI talent pool" 要和 "apply"、"future opportunities" 在一起）；`only_before_duties: true` 表示命中只在第一个职责标题之上才算（开放申请的标题行 "Initiativbewerbung"，而不是真实招聘帖结尾的同样一行）。两条可以用同一个 id |
| `title_patterns` | 岗位标题写明是人才库或开放投递（"Talent Pool - Senior Engineer"、"Open Application"、"Initiativbewerbung"）；`{id, pattern}`，每条对整条标题匹配（不判断否定，不切句子），所以要写得窄。分数用 `pipeline.yaml job_checks.ghost.evergreen_wording.title_points`；先读标题再读 JD，一个岗位只有一条这样的原因 |
| `title_exclude` | 标题匹配其中一条时没有 `title_patterns` 命中：招聘岗位本身（"Talent Pool Manager"、"Recruiter - Talent Community"） |
| `responsibility_patterns` | 职责段落的标题（"Responsibilities"、"What you'll do"、"Deine Aufgaben"），只对像标题的行测试；`{id, pattern}`。读这一行时去掉强调符号、列表 / 标题标记和前后的 emoji 或箭头，"&amp;" 当作 "&"，`’` 当作 `'`；行尾的 "…"、" -"、"—" 当作 ":"，下面紧跟列表（中间最多隔一行以 ":" 结尾或像标题的引导语）时行尾的 "..." 也当作 ":" |
| `question_words` | 疑问词（"what"、"which"、"welche…"；整词匹配）：以 "?" 结尾的标题行只有在第一个词是其中之一、且下面紧跟列表时才算标题（"What will I be doing?" / "- …"），所以 "Ready to take on new responsibilities?" 仍是句子 |
| `negation_cues` | 让人才库说法不算的词：在说法里面、说法前 `pipeline.yaml job_checks.ghost.negation_words_before` 个词内、说法后同一分句 `negation_words_after` 个词内，或在所在列表的标题里 |
| `negation_after` | 这个包的说法后面往后找多远的否定词：`words`（默认：`negation_words_after` 个词）或 `clause`（到分句结束）。`de` 用 `clause`：德语把 "nicht" 放在句末（"Für unseren Talentpool ist diese Anzeige ganz ausdrücklich nicht gedacht"） |
| `clause_breaks` | 分句在哪里结束（";"、" but "、" aber "、"and we …"、", not"、", die …"）；分句界也能把词排除在否定搜索之外：`not only`、`nicht nur`。分句界在整个句子上匹配，所以 lookaround 可能读到说法本身里面的字（`(?<=hiring)\s` 会读到说法的最后一个词，在 "always hiring" 紧后面结束分句）：lookaround 只写分句界旁边的字符 |
| `exclude_context` | 匹配到的句子（或紧挨在它前面的问句）不算：雇主的产品、客户或同名团队、岗位职责、"but this role is a concrete opening"、真实招聘帖的结尾（"Not ready to apply? … stay in touch"）、条件句、隐私说明 |
| `exclude_clause` | 和 `exclude_context` 一样，但只去掉从它的匹配处到该分句结尾（`clause_breaks` 或 `exclude_clause_ends`）的命中：对候选人的资格要求（"Experience building a talent pipeline …"、"Erfahrung im Aufbau eines Talentpools"），后面 "…; we are always hiring" 仍然算 |
| `exclude_clause_ends` | `exclude_clause` 的范围还在哪里结束（正则）：公司作主语（we、wir）之前的逗号或冒号（"…, we are always hiring"；"…, so you can staff future roles" 不是）、德语动词第二位的倒装（"… Teams stellen wir laufend ein"）。对别的判断不算分句结束 |
| `lead_in_question` | 句子前面哪个问句和它一起读：`ends`（问句结尾的字符：`?`、`？`）、`starts`（问句从最后一个这些字符或换行之后开始：`.`、`!`、`¿` 等）和 `line_above`（问句可以在上一行）。各包的列表合并；没有 `ends` 就不读问句。片段本身以 `ends` 之一结尾就是问句，不算，除非 `question_tag` 把它读成陈述句 |
| `question_tag` | 什么时候陈述句后面跟一个简短邀请不算问句（"We are always hiring – want to join?"）：`breaks`（尾巴从哪里开始的正则：" – "、"—"、";"）、`invitations`（正则；最后一个 break 之后、去掉 "?" 的文字必须整个是其中之一，且最多 `pipeline.yaml job_checks.ghost.question_tag_max_words` 个词）、`openers` 和 `markers`（正则，从说法所在分句的开头匹配到一个词的结尾，所以可以写词组：`wie(?!\s+immer)`），以及 `subjects`（正则，匹配整个词："we"、"our"、`unser\p{L}*`）。分句从说法前最后一个 `clause_breaks` 匹配、逗号或冒号开始；跳过 `markers` 之后以 `openers` 之一开头（"Recruiters, are you always hiring – interested?"），或直接以说法本身开头（"Always hiring – interested?"），或者在说法结尾之前没有 `subjects` 之一（"Tired of always hiring – interested?"；"Bei uns suchen wir laufend …" 有），仍然是问句；没有 `subjects` 就不要求主语。只搜尾巴之前的部分。各包的列表合并；没有 `invitations` 就所有问句都还是问句 |
| `abbreviations` | 句点不表示句子结束的缩写 |
| `prefilter` | 快速初筛：没有命中的 JD 或行不再找人才库说法 |

和签证一样，**`evergreen_patterns` 能匹配到的每个说法都必须包含一个 `prefilter` 命中**，否则永远看不到；`pnpm config:check` 会对正则文本里没有 prefilter 匹配的说法给出警告，写错的正则会指出路径（`ghost.evergreen_patterns[2]`，`ghost.title_patterns`、`ghost.title_exclude` 同样）。你在配置目录里放的整包副本要手动加上标题的两个键，否则不读标题。改了说法之后，接下来几轮会把所有岗位重新检查一遍；可以先用 `pnpm ghost:check` 预览。

每条 `evergreen_patterns` 说法都要在词的边界开始和结束（`(?<![\p{L}\p{N}])` … `(?![\p{L}\p{N}])`，出厂的说法都是这样）。否定判断从片段的索引里读每个命中周围的词，耗时与片段长度成线性，用撇号连起来的长串词也一样；不带边界的说法可能在一个长词（一长串字母）里命中很多次，每次都可能把这个词剩下的部分再读一遍，耗时随词长的平方增长。

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
| `clause_breaks` | 上面那个分句在哪里结束（"; "、" but "、" aber "）：之后的否定词不算。逗号和冒号不结束分句（"Relocation support: No"）。分句界在整个句子上匹配，而不是只在说法后面的文字上匹配，所以跨过说法结尾去读的分句界，按它在整句里匹配到的位置结束分句：lookbehind 看得到说法本身（`(?<=support)\s` 在 "Relocation support" 紧后面结束分句，于是 "Relocation support is not available" 里的 "not" 不再算）；`^` 只在句子开头成立，不在说法紧后面成立；正好在说法结尾处的 `\b` 或 `\B` 看得到说法的最后一个字符；从说法内部开始、越过说法结尾的匹配不算分句界，而且会盖住它覆盖范围内的其他匹配。lookahead 两种读法一样。lookaround 只写分句界旁边的字符，出厂的分句界都是这样 |
| `exclude_context` | 匹配到的句子不是在讲求职者的签证（"sponsored events"、"Visa/Mastercard"、"our customers with visa applications"） |
| `exclude_companies` | 本身就是签证词的公司名（规范化后）：对这些公司只算标了 `combo: true` 的说法 |
| `abbreviations` | 点号不表示句子结束的缩写（"z.B"、"inkl"） |
| `prefilter` | 快速初筛，见下 |

`offered`、`not_offered.*` 和 `mention_terms` 的条目是 `{pattern, combo, list_item}`：`combo: true` 表示这个说法把签证词和语境连在一起，
所以对名字是签证词的公司也算；`list_item: true` 表示只在它自己是一个列表项时才算（单独的名词 "- Visa sponsorship"），当标题时不算（"## Visa sponsorship" 下一行 "Not available"）。说法是带 `iu` 标志的正则；写错时 `pnpm config:check` 会指出路径（`visa.offered[3]`）。

每条 `offered` 说法都要在词的边界结束（`(?![\p{L}\p{N}])` 或 `$`，出厂的说法都是这样）。否定判断从句子的索引里读每个命中前后的几个词，
只有这样耗时才和句子长度成正比：命中如果开始或结束在一个很长的词里面（一长串字母），每个命中都要把这个词重读一遍，
和每个命中都把整句重读一遍一样慢。

**`prefilter`**：签证一票否决每轮过滤都要读所有未关闭的岗位，所以一段文字或一句话如果不匹配任何 prefilter，就直接跳过，
不再跑其他说法。前提是 **`offered`、`not_offered` 或 `mention_terms` 能匹配的每个说法里都含有一个 prefilter 匹配**：
加了一个带新关键词的说法（"Aufenthaltstitel"），也要把这个词加进 `prefilter`，否则永远看不到。只有含 prefilter 匹配的行（连同它上面的标题）才切成句子。
`pnpm config:check` 会对正则文本里没有 prefilter 匹配的说法给出警告（粗略检查：看的是正则本身，不是它能匹配的内容）。`prefilter` 留空就逐句读（更慢）。

改了说法之后，`pnpm visa:scan` 预览会改什么，`pnpm visa:scan --write` 写入；规则是每个结果输入的一部分，所以每轮也会把所有岗位重新检查一遍。

## 地名词典

产品自带一份离线地名词典 `config/geo/places.json.gz`：[GeoNames](https://www.geonames.org/) 里人口不少于 1.5 万的全部城市和全部国家，
带英文、德文、中文和当地名称，以及这些语言里的其他写法。任何写法都查到同一个地点（`慕尼黑`、`Múnich`、`München`、`Munich`
是同一条），不分大小写和重音；同名的地点（英格兰的 Cambridge 和马萨诸塞州的 Cambridge）是不同条目，靠国家和一级行政区区分。
查词典不联网。

当前文件有 34 210 个城市、252 个国家、2 764 个一级行政区（压缩后 0.95 MB，JSON 2.8 MB）；其中 11 226 个城市有中文名，其余以英文显示。
中文名照 GeoNames 原样收录，有些是繁体。

重新生成：`pnpm geo:build` 把 `cities15000.zip`、`countryInfo.txt`、`admin1CodesASCII.txt`、`alternateNamesV2.zip`（约 210 MB）
下载到仓库外的缓存目录（`--cache <dir>`，默认系统临时目录；`--refresh` 重新下载），再重写这个文件。同样的下载得到同样的字节；
文件头记录了下载日期。

GeoNames 数据采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可，署名见 `NOTICE`。

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

## 地点设置的迁移

`preferences.yaml` 会从版本 2 转换到版本 3，读取时和运行 `pnpm config:migrate --write` 时都会转换。分数不会因此过期：

| 旧 | 新 |
|---|---|
| `locations` 的第一项 | `home_city` |
| `locations` 的其他项 | `relocate: true` 的地点 |
| `remote_scope: home_country` | 不新增 |
| `remote_scope: {region: [...]}` | 每个代码按原样成为仅远程地点 |
| `remote_scope: worldwide` | `Worldwide` 成为仅远程地点 |
| `remote_scope: none` | 从 `workplace` 去掉 `remote`，除非它是唯一的值 |
| 同时出现在 `locations` 和 `remote_scope` 里的地点 | 一条 ✈：愿意搬去的地方也包括在那里远程 |

结果有变化的情况：设为 `none` 时，地点在允许城市的远程职位过去会显示，现在会以 `workplace_not_wanted` 隐藏；设为 `none` 且 `workplace: [remote]` 时，远程职位现在会被检查，不再被隐藏；`{region: [...]}` 没有包含本国时，本国的远程职位现在会显示；`locations` 里的国外城市变成 ✈ 地点并开始匹配。`locations: [Berlin, CH]` 加 `remote_scope: {region: [CH]}` 现在除了瑞士的远程岗，也保留德国的。如果 `locations` 的第一项是国外城市（德国市场的 `[Amsterdam, Berlin]`），它会成为常住城市，那里的职位按本国比较；`config:check` 和 `/me` 会提醒常住城市不在本国，你可以改设本国的城市，把另一个列为 ✈。

`search.yaml` 的 `locations` 和 `remote_scope` 仍可接受但不再生效，也没有迁移步骤：搜索来自 `places`，`config:check` 和 `/me` 会提醒 `places` 里没有的内容，以及 `places` 新增、而这两个键没列出的搜索。两个文件一致时，升级后查询和查询 id 不变，轮转历史得以延续。这些配置会增加或改变搜索：

| 旧配置 | 变化 |
|---|---|
| 含多个代码的范围 | 每个代码一次搜索，id 是新的 |
| 不覆盖本国的范围 | 增加本国的远程搜索 |
| `none` 且 `workplace: [remote]` | 增加本国的远程搜索 |
| `locations` 里的国外城市 | 增加它的远程搜索 |
| `workplace` 没有 `remote`，范围不是 `none` | 去掉远程搜索，因为这和迁移后的 `none` 无法区分 |

旧 `locations` 里的现场搜索只有是常住城市或 ✈ 地点时才算列出了，因为只有它们有现场搜索；范围代码是本国或任何列出的地点就算。所以仅远程的 `CH` 不会盖住旧的现场搜索 `Switzerland` 的提醒。

同一个网站会以同样方式发出的搜索，每轮只跑一次。在去掉网站发送不了的搜索的那一步里，如果一个单元里每个已启用、已配置的通道发出的请求都相同，两条查询就合并：Apify 设了 `remote_locations.region: Europe` 时，`{region: [eu]}` 和 `{region: [CH]}` 发往同一个地点，只算一次付费运行；Arbeitsagentur、StepStone、XING 和 JSearch 的远程搜索不带地点，每个关键词组只跑一次远程搜索。判断不了的通道（LinkedIn 会话、Monid、jobspy）把每条查询分开，所以启用了其中之一的级联不合并。

已知限制：✈ 城市按数据表给它的国家搜索，所以即使旧配置指的是马萨诸塞州的 Cambridge，✈ `Cambridge` 也搜英国（过滤仍在本国保留 Cambridge）；常住美国时 ✈ `Paris` 也保留 `Paris, TX`。Arbeitsagentur 只认德语地名（`München`、`Deutschland`，以及 `sources.arbeitsagentur.location_names` 里的城市），国外的地点在那里搜不到结果；它是免费网站，所以不跳过。

每次读取 `preferences.yaml`，不管是谁写的（表单、设置向导、`pnpm run setup`、答案文件或手改），`places` 都按同一套规则处理：

- Worldwide 一律是仅远程。
- 和常住城市相同的地点去掉。
- 同一地点写了两次只算一条，留在第一次出现的位置，其中任一条是 ✈ 就是 ✈。比较时不分大小写、重音和空格；读得到市场地名表的地方，同一地点的两种写法（Munich、München）也算一条。

地点条数和名字长度都没有上限，和原来的 `locations` 一样。

评分提示词里的远程范围由地点得出：任一地点是 Worldwide 就是全球；否则是其中的国家和区域，仅远程的和 ✈ 的都算，没有仅远程的国家或区域时再加上本国；一个国家或区域都没有时就是本国。过滤直接读地点（见上），本国总在其中。

设置向导只写 preferences.yaml：search.yaml 的旧键保持原样，不再生效。要停掉远程搜索，就从办公方式里去掉“远程”。

旧版本的代码读不了版本 3。要退回旧版本，请放回升级前的版本 2 文件：`pnpm config:migrate --write`（部署时会运行）会把它复制到 `data/config/.backup/<时间>/profile/preferences.yaml`，也可以从你自己的备份里取（[备份与恢复](backup-restore.zh.md)）。用 `/me` 上的画像历史恢复旧版本没有用：保存时又会转换成版本 3。

## 改名的配置键

配置迁移（`pnpm config:migrate --write`）会改名；改之前旧文件在内存里照常可用。

| 文件 | 之前 | 现在 |
|---|---|---|
| preferences.yaml | `salary_floor_eur_year` | `salary_floor_year`，并新增 `market` |
| preferences.yaml、search.yaml | `remote_scope: eu_hire_in_de / eu_any` | `home_country` / `{region: [eu]}`，在 preferences.yaml 里再转为地点（见上文） |
| sources.yaml | `remote_locations.eu_hire_in_de / eu_any` | `home_country` / `region`；德国的招聘网站加 `markets: [DE]` |
| pipeline.yaml | `language.german_*`、`salary.fx_to_eur` | DE 包的 `requirement`；`salary.fx_pivot: EUR` + `fx_rates` |
| ai.yaml | `scoring.german_penalty`、`priority.weights.german_gap` | `language_penalty`、`language_gap` |
| insights.yaml | `salary_bucket_eur`、`salary_bucket_cap_eur` | `salary_bucket`、`salary_bucket_cap` |
| interests.yaml | 金额类别的 `amount.min_annual_eur`、`amount.rough_fx_to_eur`；保存视图的 `filters.hideGerman` | `amount.min_annual`、`amount.rough_fx`（基准货币）；`filters.hideLang` |

`amount.assume_currency`（金额没写币种时按哪种货币算）可以写 `market`：市场的基准货币。/jobs 和今日页的 URL 用 `hideLang`；
带 `hideGerman` 的旧链接照常可用。
