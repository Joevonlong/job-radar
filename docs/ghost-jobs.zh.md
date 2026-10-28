# 幽灵岗位

[English](ghost-jobs.md) | [中文](ghost-jobs.zh.md)

"幽灵岗位"指背后没有真实空缺的招聘帖：人才库、挂了好几个月的岗位、换个编号反复重发的岗位。Job Radar 可以给有这些迹象的岗位打标记。它只用规则（不调 AI，不花 token），**只是提示**：不改分数、排名、筛选结果和推送，有标记也不代表岗位是假的。

这个检查**默认关闭**。先预览（下面的 `pnpm ghost:check --json`：读所有在招岗位，什么都不写），觉得被标记岗位的比例符合你的市场再到 `ui.yaml` 打开。

自动扫描和统计数字不含休眠岗位；显式指定岗位 id 仍可检查，已有标记仍在详情页保留。

## 信号

每个信号加分，分值在 `pipeline.yaml: job_checks.ghost`（默认值见下）。

| 信号 | 什么时候算 | 分 |
| --- | --- | --- |
| `long_open` | 来源给出可信发布日期（公司 ATS、用你的登录读的 LinkedIn）的在招岗位，挂了至少 90 天（1 分）或 180 天（2 分）。没有可信日期时从 Job Radar 第一次见到它算起，最多 1 分。 | 1–2 |
| `repost_label` | 来源自己把帖子标成"重新发布"（用你的登录读的 LinkedIn） | 1 |
| `reposted` | 同一个来源在同一地点以新编号重新挂出，距上一次至少 30 天。只有同一帖子编号不变的来源算（公司 ATS、用你的登录读的 LinkedIn、StepStone、XING、Arbeitsagentur）；两个不同来源之间从不算。 | 2 |
| `evergreen_wording` | JD 写明是人才库或常年招聘（"This posting is for our talent pool"、"We are always hiring"、"Wir stellen laufend ein"、"Initiativbewerbung (m/w/d)"、"Es gibt keine konkrete Stelle"）。"We're always looking for people who …" 不算（很多真实招聘帖的公司介绍都这么写） | 2 |
| `thin_description` | JD 来自保留全文的来源，且不到 120 个词，或没有职责段落（"Responsibilities"、"Your tasks"、"What will I be doing?"、"The impact you'll have"、"Deine Aufgaben"、"Darum geht's" 这样的标题；读标题时去掉前后的 emoji 和箭头，"&amp;" 当作 "&"，行尾的 "…" 当作 ":"；以 "..." 结尾、或疑问词开头且以 "?" 结尾的行，只有下面紧跟列表时才算标题（中间最多隔一行以 ":" 结尾或像标题的引导语），所以公司介绍里的 "Which tasks can our AI automate?" 不算）。岗位有当前的 [JD 拆解](breakdown.zh.md)时，以拆解里的职责列表为准（职责列表为空也算），不看标题。`thin_description.infer_from_headings: false` 时不看标题：没有当前拆解时只有篇幅短才算。 | 1 |

分数加起来得到等级：

| 等级 | 分数 | 显示 |
| --- | --- | --- |
| `none` | 低于 3 | 不显示 |
| `watch` | 3 及以上 | 灰色"留意" |
| `likely` | 5 及以上，**并且**至少有 `repost_label`、`reposted`、`evergreen_wording` 之一 | 橙色带斜纹的"疑似幽灵" |

只靠时间和篇幅不会到 `likely`：又老又短的 JD 停在 `watch`。`trusted_companies` 里的公司从不标记。

## 怎么读 JD 的说法

JD 先切成片段（句子、列表项、短标题和它下一行），和[签证检查](visa-sponsorship.zh.md#怎么读一条-jd)一样。含"人才库"类说法的片段在下面情况**不算**：

- 否定词在说法里面、说法前 `negation_words_before` 个词内、说法后同一分句里（`negation_words_after` 个词内；德语到分句结束，因为德语把 "nicht" 放在最后），或在它所在列表的标题里（"This is not a talent pool posting"、"Für unseren Talentpool ist diese Anzeige ganz ausdrücklich nicht gedacht"）。"not" 前的逗号、德语关系从句或连词前的逗号（"…, die keine Angst vor neuen Technologien haben"）结束分句；"not only"、"nicht nur" 不算否定；
- 片段本身是问句（"Always hiring? Acme automates your sourcing"、"Is your company always hiring – interested?"）。陈述句后面在破折号或 ";" 后跟一个简短的邀请，不算问句："We are always hiring – want to join?"、"When we grow, we are always hiring – want to join?"、"Wir stellen laufend ein – neugierig geworden?" 算（这个尾巴最多 `question_tag_max_words` 个词，并且整个是包里的某个邀请说法；见 [market-packs.zh.md](market-packs.zh.md#幽灵岗位说法) 的 `question_tag`）。说法所在的分句（从逗号或冒号之后算）以疑问词或动词开头（"Recruiters, are you always hiring – interested?"、"Liebe Recruiter, stellen Sie laufend ein – neugierig?"），或者没有主语、直接以说法本身开头（"Always hiring – interested?"），仍然是问句；这个分句在说法结尾之前没有以公司为主语（"we"、"our"、"wir"、"uns"）也还是问句："Tired of always hiring – interested?"、"You're always hiring – curious?" 不算，"At Acme we are always hiring – want to join?"、"Did you know: we are always hiring – curious?"、"Bei uns suchen wir laufend Verstärkung – bist du dabei?" 算；
- 讲的是雇主的产品、客户或同名团队（"We build talent pool software"、"Our ATS lets hiring managers add candidates to the talent pipeline"、"Evergreen job listings are a core feature of our ATS"、"Join our Talent Network team"、"Our SaaS lets agencies post evergreen job listings"、"Wir helfen Unternehmen beim Aufbau ihres Talentpools"、"Unsere Software hilft Personalabteilungen beim Aufbau eines Talentpools"；"Our SaaS team is always hiring" 则算）；
- 是这个岗位的职责（"You will build our talent pipeline"、"You will source candidates for our upcoming roles"、"You will screen applicants for our engineering talent pool"、"Identify and attract candidates for our talent pool"、"Your tasks:" 或 "What will I be doing?" 下面的列表项）；"We are building a talent pool"、"We are hiring for our AI talent pool"、"Help us grow by joining our talent pool" 则算；德文里招聘人员自己的职责同样不算（"Als Recruiter sprichst du Kandidaten für unseren Talentpool an"、"Ansprache von Kandidaten für unseren Talentpool"），"Bewirb dich jetzt für unseren KI-Talentpool" 则算；
- 是对候选人的资格要求（"Experience building a talent pipeline for future roles"、"Experience with talent pipelines for future roles"、"Berufserfahrung im Aufbau eines Talentpools für zukünftige Stellen"）：只去掉从这个说法到它所在分句结尾（";"，或 "we"/"wir" 前的逗号；"you"/"du" 前的不算："Kenntnisse im Aufbau von Bewerberpools bringst du für zukünftige Vakanzen mit" 不算）的部分，所以 "Experience building a talent pipeline is valued; we are always hiring" 仍然算。"Your experience building talent pipelines for future roles" 是候选人的经历；公司自己的经历不是资格要求："With our history of growing fast, we are always hiring"、"Mit unserer Erfahrung in der Entwicklung von KI-Produkten stellen wir laufend ein" 算；
- "Initiativbewerbung" 作为单独一行的标题出现在第一个职责标题之下（真实招聘帖里的一节）；"Initiativbewerbung (m/w/d)" 在哪里都算；
- 是为以后岗位做的培训，或给社群办的活动（"Mentoring for our future roles"、"Leadership development for our upcoming positions"、"Weiterbildung für zukünftige Positionen"、"Karriereentwicklung für zukünftige Positionen"、"Organize events for our engineering talent community"、"Organisiere Events für Kandidaten in unserem KI-Talentpool"、"Business development opportunities for future roles"）。"development" 只有挨着培训用词（professional、personal、leadership …；opportunities、programs …）才算培训："We hire in AI development for upcoming positions"、"Wir suchen Verstärkung in der Entwicklung für zukünftige Positionen" 算。和这个列表里其他排除一样，活动会去掉整句："Bewirb dich für unseren KI-Talentpool und erhalte Einladungen zu Events für unsere Talent-Community" 不算；
- 需要招聘语境的说法，同一句里没有招聘用词："join our AI talent pool" 要和 "apply"、"candidates"、"future opportunities" 这类词在同一句才算（"By joining our AI talent pool, you will be contacted … for our future opportunities"；"networking opportunities" 不算），"access to the largest tech talent pool in Europe" 永远不算；
- 后面又说这是真实空缺（"…, but this role is a concrete opening"、"this role is based in Berlin"）；
- 是真实招聘帖的结尾（"Don't see a role that fits? Join our talent community"、"Not ready to apply? Join our talent community to stay in touch"、"Keine passende Stelle dabei? Dann bewirb dich initiativ"；紧挨在前面的问句也一起看，见 [market-packs.zh.md](market-packs.zh.md#幽灵岗位说法) 的 `lead_in_question`）、条件句（"If there is no open role…"）、隐私说明，或"也可能考虑你应聘以后的职位"。

引文是 JD 原文的一段，带位置。[AI 陷阱检测](ai-traps.zh.md)找到的对读者隐藏的文字不算。说法写在市场包里（[market-packs.zh.md](market-packs.zh.md#幽灵岗位说法)）；英文说法所有市场都有，德文只在德国市场。

## 在哪里看到

只在 `ui.yaml: job_checks.ghost.enabled` 为 `true` 时：

- **列表**（/jobs、今日、收藏）：分数下面的标记。悬停提示列出最强的三个原因，并说明分数不受影响。
- **筛选**（/jobs、筛选标签、保存的视图）：**全部**（不筛）、**只看疑似**（`ghost=only`：`watch` 和 `likely`）、**隐藏疑似**（`ghost=hide`：去掉 `likely`，还没检查的岗位保留）。已排除的岗位按无标记算。检查关闭时，URL 或保存的视图里的 `ghost=` 被忽略但保留，和签证筛选一样。
- **详情页**：分数卡上的标记（点击跳到检查卡），检查卡上的 **岗位真实性** 一行，在 AI 陷阱之后、签证之前。列出所有原因，引用人才库那句话并带 **查看原文**（JD 里用波浪下划线标出），还有 **不是幽灵岗位** 按钮。

流程看板不显示标记。

## 不是幽灵岗位

详情页的 **不是幽灵岗位** 会排除标记：列表、分数卡、JD 里的波浪下划线和"只看疑似"筛选里都不再出现。排除时记下岗位当时的原因种类；以后出现新的种类（比如又重发了），标记会回来。**撤销** 取消排除。其他什么都不变。

## 什么时候运行

每轮的 `signals` 步骤在 AI 陷阱和签证检查之后运行它。只有岗位的输入变了（JD、状态、来源、AI 拆解、隐藏文字、说法、设置或来源的声明），或者到了下一个 `long_open` 档位，才会重新检查；每轮最多 `pipeline.yaml: job_checks.ghost.per_cycle_limit` 个（没检查过的先，新的先）。出错时这一步记为 "partial"，下一轮重试。

```bash
pnpm ghost:check                 # 预览：每个在招岗位会得到什么，什么都不写（检查关闭时也能用）
pnpm ghost:check --json          # 同上，JSON 格式，带每个等级的比例
pnpm ghost:check --write         # 写入结果（只在检查打开时；最多 per_cycle_limit 个；第二次运行报告 0 个变化）
pnpm ghost:check --job 1234      # 只查一个岗位，即使结果是最新的也重查
pnpm ghost:check --limit 500     # 最多 500 个（新的先），预览和写入都适用
```

## 设置

`ui.yaml`（你的）：

```yaml
job_checks:
  ghost:
    enabled: false             # true：每轮检查岗位，页面显示标记
    trusted_companies: []      # 从不标记的公司名，例如 ["Acme GmbH"]；加进来后标记立刻消失
```

`pipeline.yaml`（随产品提供），见 [configuration.zh.md](configuration.zh.md#幽灵岗位检查pipelineyaml--uiyaml)：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `job_checks.ghost.per_cycle_limit` | 2000 | 每轮最多检查的岗位数 |
| `job_checks.ghost.levels` | `{ watch: 3, likely: 5 }` | 各等级的分数线 |
| `job_checks.ghost.long_open.tiers` | 90 天 → 1，180 天 → 2 | 挂的天数和分值 |
| `job_checks.ghost.long_open.first_seen_max_points` | 1 | 没有可信发布日期时最多给几分 |
| `job_checks.ghost.repost_label.points` | 1 | |
| `job_checks.ghost.reposted.min_gap_days`、`.points` | 30、2 | |
| `job_checks.ghost.evergreen_wording.points` | 2 | |
| `job_checks.ghost.thin_description.min_words`、`.points` | 120、1 | |
| `job_checks.ghost.thin_description.infer_from_headings` | `true` | 没有当前 JD 拆解时，由职责标题判断长 JD 有没有职责段落；`false`：不看标题，只有篇幅短才算 |
| `job_checks.ghost.quote_max_chars` | 280 | 引文最长字数 |
| `job_checks.ghost.negation_words_before` / `_after` | 6 / 5 | 人才库说法前后查否定词的词数 |
| `job_checks.ghost.heading_max_chars` | 60 | 当作标题、和下一行合读的最长行 |

每个信号也有 `enabled`；`points: 0` 同样关掉它。

## 它不做什么

- 它不知道岗位是不是真的：大公司会故意长期挂着一些岗位，短 JD 也可能是老实写的。看原因，别只看标记。
- 不改分数、排名、AI 评分输入、筛选结果和 Telegram 消息。
- 只读英文和德文说法。

## 回滚到旧版本之前

旧版本不认 `ui.yaml` 里的 `job_checks.ghost`，也不认市场包 `rules.yaml` 里的 `ghost` 一节。回滚前从 `ui.yaml` 删掉 `job_checks.ghost`，从你自己的市场包里删掉 `ghost` 一节。`job_ghost` 表可以留着：旧版本不读它。
