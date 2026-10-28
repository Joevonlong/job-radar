# 岗位信息提取规则

处理流水线（`pipeline` 步骤）从 JD 文字里读出几个事实。词表和阈值都在 `pipeline.yaml`（随产品发布的文件：把 `config/pipeline.yaml` 复制到 `data/config/pipeline.yaml` 再改你的副本），改了之后用 `pnpm reprocess` 让已入库的岗位按新规则重读（采集到的原文不动）。原则不变：JD 没写的就是 `unknown`，不推测。

## 办公方式（`workplace`）

来源给了值就用来源的；来源没给（`unknown`）时才读文字，规则在 `workplace` 段：

- `head`：标题、地点文字、合同提示，各自单独匹配，比较宽松（"(Remote)"、"Berlin (Onsite)"、"Hybrid – Munich"）。只出现一种方式就用它。
- `text`：描述正文，严格（"hybrid work model"、"3 days in the office"、"Home Office möglich"、"100% remote"、`#LI-Hybrid`）。福利列表里的 "Remote Working Furniture"、"home office stipend"、"100% remote work option during pregnancy" 不算。
- `negation_patterns`：同一句里命中前面有否定词（"not available as fully remote"、"we do not offer remote-only roles"）就不算。
- 同一处出现两种以上方式（"remote 或 hybrid"）保持 `unknown`，不选边。
- 带标签或括号的写法也算：`Location: Berlin - On-site`、`Deutschlandweit (Hybrid)`、"im Büro oder remote"、"Bürotage"、"Mobilarbeit"、"Office-First-Kultur"。

办公方式会影响硬过滤：`remote` 的岗位按"欧盟范围远程"判断地点，所以 JD 明说远程但地点在范围外（Manila、Remote - India）会被过滤，写 "Germany" 的远程岗位会通过。

## 德语等级（`german_level_required`）

这是德国市场的本地语言步骤：规则来自市场包（`config/packs/de/language.yaml`）；市场包没有这门语言的规则时跳过这一步（见 [market-packs.zh.md](market-packs.zh.md)）。

| 值 | 含义 | 扣分 |
|---|---|---|
| `B1`…`C2` | JD 要求这个等级（"fließend"、"verhandlungssicher"、"gute Deutschkenntnisse"、"German C1"） | 按 `ai.yaml: scoring.language_penalty` |
| `preferred` | 德语只是加分项（"German is a plus"、"Preferred: Fluent in German"、"Preferred Qualifications" 标题下、"von Vorteil"） | 不扣 |
| `none` | JD 明说不需要德语（"No German required"） | 不扣 |
| `unknown` | 没提到等级 | 不扣 |

- 加分词（`german_optional_patterns`）只看离 "German" 不超过 `german_optional_max_distance` 个字符的，而不是整个分句：LinkedIn 的描述没有标点时，一个"分句"可能是整段话。
- "加分项"标题（`german_preferred_section_patterns`，例如 Preferred Qualifications / Nice to have）之后的德语是 `preferred`，除非遇到别的标题（`german_required_section_patterns`）或同一句里有 "required / erforderlich"（`german_required_patterns`）。
- "German, Spanish, French or Italian are a plus" 这种语言列表：逗号后面全是语言名时，结尾的加分词仍算在 German 头上（`german_list_languages`）。
- "C1-Deutschkenntnisse sind von Vorteil, B2-Niveau ist ausreichend"：加分项之后同一句里"等级 + ausreichend / genügt / sufficient / enough"（`german_sufficient_patterns`）说明这个等级才是最低要求，读作该等级（这个例子读 B2，扣分）。
- "German citizen"、"German defence company" 这类不是在说语言的词组先被抹掉（`german_ignore_patterns`）。
- AI 的 `german_level_required` 和规则值的交叉检查：不一致时 JD 里明写 CEFR 等级的那个胜出，且只数"要求"（"German C1 is a plus" 里的 C1 不算明写）；规则读到 `preferred` / `none` 时规则胜出。已打分的岗位在每次打分前按新的规则值重新计算扣分（不调 AI）。

## 中介 / 猎头（`is_agency`）

公司名在 `company.agency_names`，或匹配 `agency.company_name_patterns`，或标题 / 正文匹配 `agency.text_patterns`（"on behalf of one of our customers"、"exclusively retained"、"I'm hiring … to join a … company"、"Im Auftrag unseres Kunden"、"recruitment agency"、"Personalberatung"）。雇主声明不要中介的句子（"we do not accept unsolicited CVs from recruitment agencies"，`agency.exclude_context_patterns`）不算。标记在合并时只增不减，所以全量 `pnpm reprocess` 会先清掉岗位上的办公方式、德语等级和中介标记再按原文重建。

## 合同类型（`contract`）

`contract` 段：学生 / 实习只看标题和合同提示；劳务派遣、自由职业、定期（`fixed_term`）、长期（`permanent`）。顺序：student > temp_agency > freelance > fixed_term > permanent，所以 "Vollzeit, befristet" 是定期。劳务派遣只认 `Zeitarbeit` / `Arbeitnehmerüberlassung` 本身："Personaldienstleister" 只说明发布者是中介，不再算劳务派遣；正文写明是中介代招、直接受雇于客户（`contract.direct_hire`："Vertragsart: Personalvermittlung"、"Direktvermittlung"、"im Rahmen der Personalvermittlung"、"direkte Festanstellung bei unserem Kunden"）时，即使中介的公司简介里提到 Zeitarbeit 也不算劳务派遣。这类岗位会保留，靠 `agency` 打上"中介"标签（`agency.text_patterns` 里有 `Personalvermittlung`、`Personaldienstleister`）。另外补了德英写法：`unbefristet`、`Festanstellung`、`open-ended contract`、`Dauerstelle`、`Mutterschaftsvertretung`，以及带标签的 `Employment Type: Permanent`、`Art der Anstellung: Festanstellung`。Vollzeit / full-time 说的是工时不是合同期限，不算长期，合同保持 `unknown`。福利里的 "full-time employees"、"equal employment opportunity" 不算。大多数 JD 根本不写合同类型，所以仍是 `unknown`。

## 中介名单与措辞补充

`company.agency_names` 补了 Haystack、Rocken、Instaffo、Optimus Search；`agency.text_patterns` 补了 "hiring on behalf of …"、"Im Kundenauftrag"。

## 跨公司名归并

同一岗位在不同来源里公司名写法不同（"SIV.AG" / "SIV.AG - Service für Informationsverarbeitung AG"、"Allianz in Deutschland" / "Allianz Kunde und Markt GmbH"）时，原来只在同一个公司名下找重复，所以漏合并。现在公司名相关（一个是另一个的词前缀，或首词相同）、标题相同、SimHash 距离 ≤ `dedupe.cross_company_simhash_max_distance`（默认 14，比同公司的 `simhash_max_distance` 宽，因为 StepStone 和 LinkedIn 的同一份 JD 样板文字不同）才合并。已经入库的重复岗位不会被追溯合并，只对之后新进来的岗位生效。

## 公司和标题的匹配键

判断两条 posting 是不是同一个岗位（以及同一家公司），靠的是匹配键：公司键是公司名转小写、去掉重音和法律形式（GmbH、Inc. 等），
标题键是标题转小写、去掉性别标记（"(m/w/d)"）和标点；精确匹配还要比较城市。三者都保留所有文字的字母和数字，所以 "Яндекс"、
"株式会社メルカリ"、"Ørsted A/S" 各有自己的键，同一公司的 "バックエンドエンジニア" 和 "プロダクトデザイナー" 是两个岗位，同一职位在
東京 和 大阪 也是两个岗位。只去掉拉丁、希腊、西里尔字母上的重音（"é" = "e"）；其他文字里属于字母本身的符号保留（天城文、泰文的
元音符号，日文的浊点：ジム 和 シム 是不同的词）。ß 读作 ss，所以 "Straße GmbH" 和 "Strasse GmbH" 是同一家公司。没有任何字母或
数字的公司名以原名作键；没有任何字母或数字的标题不用来匹配两条 posting（只有同源和 SimHash 检查可以合并它）。

之前的版本只保留 a–z 和数字：用其他文字（西里尔、希腊、希伯来、阿拉伯、中日韩等）写的名字、标题或城市，键是空的，或者只剩其中
的拉丁部分（"シニアAIエンジニア" 成了 "ai"）；公司名里的 Ø、Ł、Æ、ß 这类字母会被丢掉。**升级后**，第一个处理轮（或
`pnpm reprocess`）在归档新 posting 之前把已存的键重算一次：

- 只改新规则会改变的键；含 ß 的德语公司名会重算一次键。名字和标题只用拉丁字母、也没有上述字母的数据库完全不变；
- 重算后键相同的两家公司合并成一家：岗位、薪资查询、别名、ATS 看板、关注 / 拉黑标记都保留；已缓存的薪资查询跟着新的公司键和
  标题键走；
- 名字混用两种文字、被关注或拉黑的公司（"Mercari, Inc. (株式会社メルカリ)"）以前和它的拉丁写法（"Mercari Inc."）共用一个键；
  现在为那个写法另建一行，带同样的标记，两种写法都保持标记；
- 键没能重算时（数据库出错），这一轮不归档任何 posting：它们留在待处理，pipeline 步骤记为失败，下一轮再试。`pnpm reprocess`
  这时以退出码 1 停止。

旧的键已经错误合并的岗位（两个雇主在同一家公司下、两个职位在同一个标题下）会一直保持合并，直到你运行一次：

```bash
pnpm reprocess --split-merged
```

它检查所有带有“公司键或标题键变了”的 posting 的岗位，只拆下旧键把它匹配进来、而新键不会匹配的 posting（作为另一来源的同一
posting 合并的、或者因为描述几乎相同合并的，都不动）。然后照常重新处理：每条拆下来的 posting 在自己的公司下成为单独的岗位（或者
并入它真正所属的岗位）。原岗位的状态、投递、备注、收藏和打分保留。你处理过的岗位（投递、收藏、过滤或关闭的决定）不会换公司：它
自己的 posting 现在指向另一家公司时，保持原样不动；这两类岗位在运行结束时按 id 列出，值得看一眼。所有 posting 都是拉丁文字时不
需要做任何事。暂不处理：旧版本把同一公司、同一标题、两个用其他文字写的城市（東京 和 大阪）的 posting 合并成的岗位仍是一个岗位，
因为它的地点里两个城市都有；这类城市的新 posting 会分开。

## 来源行的地点

岗位详情页的来源区每行显示该来源自己写的地点（`job_sources.location_label`；`pnpm reprocess` 会补上已有来源的地点）。一个岗位由同一公司 ATS 的多份 posting 合并而成时（Databricks 各办公室），靠它区分每行。

## 描述整理（`description`）

- `trailing_ui_patterns`：删掉采集留在末尾的界面文字（"Show more Show less"）。
- `restore`：整段没有换行的长描述（Bright Data 的 `job_summary`）按已知小标题、行内列表符号和句子恢复段落与列表，只加换行，不改任何文字。Bright Data 的 LinkedIn 数据集现在同时请求 `job_description_formatted`（HTML），有的话优先用它，段落和列表原样保留；老的采集记录没有这个字段，走上面的整理。

## 重新处理已入库的岗位

```bash
pnpm reprocess            # 全部通道
pnpm reprocess --channel linkedin-brightdata
pnpm reprocess --split-merged   # 升级后运行一次，见“公司和标题的匹配键”
```

（在项目目录运行。）全量运行先清掉岗位上的办公方式、德语等级、中介标记（`--channel` 时不清，只补充），再把已解析的原文放回待处理，依次跑 `pipeline`、薪资（用当前解析重读所有岗位的原文并修正已存的薪资，见 [signals.zh.md](signals.zh.md)；`--channel` 时也是全部岗位）、硬过滤、规则信号、薪资信号同步、加分、已打分岗位的德语扣分；不采集、不调 AI。有岗位延迟处理或规则扫描失败时退出码为 1，参数错误为 2。描述变了的岗位：规则信号会重新扫描，AI 信号复核和译文在之后的处理轮里按需重做（会用到 AI 额度）。
