# 薪资水平和查薪资

[English](salary.md) | [中文](salary.zh.md)

岗位页“薪资与福利”下面有两张薪资卡：

- **薪资水平**（一直开着，不用 AI）：这个岗位写明的薪资，在你采集到的同类岗位里排在什么位置；另外给出薪资网站的链接。
- **查薪资**（默认关闭，用 AI 和网页搜索）：你点了才查，AI 在公开网页上搜这家公司的薪资水平和这个职位的薪资区间，并列出来源。

两者都在 `salary.yaml` 里设置（设置 → 薪资，或“高级”标签）。

## 薪资水平：基准

每轮采集结束后，`pipeline` 步骤用库里的岗位重建基准：

1. 写明薪资的岗位换算成按年、按市场基准货币的数字（和薪资卡上的换算值一致）。只算最近 `benchmark.window_days`
   天内首次发现的岗位。
2. 按标题归入**岗位族**：`role_families` 里第一个匹配的族胜出（`LLM Engineer` → 机器学习 / AI 工程师）。不匹配任何族的
   标题不进基准。
3. 按 岗位族 × 资历 × 地点 分组；薪资数不少于 `benchmark.min_sample` 的组保留分位数（P10、P25、中位数、P75、P90）。

岗位页从最窄的组开始找：“同族、同资历、同城市”，再到“同国家”“任意资历”“只看岗位族”，并写明用的是哪个组、组里有多少个
薪资。有薪资的岗位显示位置（“P72：高于中位数”），没写薪资的岗位也能看到所在组的区间。只有几个岗位的组只是粗略参考，
样本数总会显示出来。

打开 `benchmark.include_ai_lookups` 后，已完成的 AI 查询（基本工资、可信度中或高、至少一个来源在
`lookup.allowed_fetch_domains` 的主机上、地点一致）也计入；地点只写到国家的区间只算进国家，不算进城市；卡片会把两种
样本数分开显示。默认关闭，让岗位自己写的薪资和 AI 估算分开。

`pnpm salary:benchmark` 立即重建基准并打印出来（`--json` 输出原始分组）。

### 薪资网站链接

`deep_links` 列出卡片链接到的搜索页，用岗位的公司、标题或城市填进去；默认是 Levels.fyi、Glassdoor 和 Kununu。链接在你的
浏览器里打开，Job Radar 从不抓取这些网站。这些网站会拦截自动化客户端，所以链接格式是人工核对的；网站改了 URL 时，在
`salary.yaml` 里改模板。

| 占位符 | 替换成 |
|---|---|
| `{company}` | 公司名 |
| `{company_slug}` | 公司名小写、单词用 `-` 连接 |
| `{title}` | 岗位标题 |
| `{city}` | 城市 |
| `{country}` | ISO 国家代码 |

## 查薪资（AI 加网页搜索）

用 `lookup.enabled: true` 打开（设置 → 薪资 →“开启查薪资”）。岗位页随后出现“查薪资”按钮，不点就不会查。

点了之后：

1. 网页端排一个 `salary_lookup` 请求，由 ai-worker（容器模式下是 runner）领取。
2. 发给 AI 的只有**公司名、岗位标题、城市、国家和资历**，从不发你的画像，也不发 JD。AI 搜索网页、读薪资页面，回答公司的
   薪资水平、这个职位的区间、这家公司的相关职位、可信度，以及每个数字的来源。
3. 存之前先检查：每个数字都要有答案里给出的 https 来源链接；超出 `lookup.sanity_annual` 的数字丢掉；金额换算成基准货币
   （没有汇率的货币只按原币显示，超过 `lookup.unconvertible_max_annual` 的数字丢掉）；
   不在 `lookup.allowed_fetch_domains` 里的来源标成“其他来源”。卡片会写明丢掉了几条。
4. 结果保存 `lookup.ttl_days` 天，同公司、同岗位族、同资历、同地点的岗位直接显示，不再重新查。“重新查询”会强制再查。

限制：

- `lookup.max_per_day`：每 24 小时最多查几次（每次请求都算，失败的也算；直接用缓存的不算）。用完后岗位页的按钮变灰，直到较早的查询满 24 小时。
- `lookup.timeout_seconds`：一次查询的总时长，所有 provider 和重试加在一起。
- `lookup.max_searches`：每次查询最多搜索几次。Anthropic API 严格执行；CLI 只是被要求遵守。
- `lookup.web_search_usd`：Anthropic API 每次网页搜索的费用，计入 AI 用量和每月 API 预算。
- `lookup.allowed_fetch_domains`：每一项必须是一个具体网站。`co.uk`、`com.au`、`github.io` 这类公共后缀会被拒绝，因为它们等于
  放行下面所有网站。列表为空时 Anthropic API 完全不搜索。

由哪个 AI 来查，是 `ai.yaml` 里的任务 `salary_lookup`（设置 → AI → 任务覆盖）。只会尝试能搜索网页的 provider：

| Provider | 怎么搜索 | 域名限制 |
|---|---|---|
| `claude-cli`（默认，第一个） | WebSearch 和 WebFetch 工具，只对 `allowed_fetch_domains` 里的域名预先放行；需要 `claude` 2.1.296 或更新 | 只能打开列出的主机上的页面；搜索本身不受限 |
| `anthropic`（默认，第二个） | API 的服务端网页搜索工具 | 只采用列出域名的搜索结果 |
| `codex-cli`（只有你自己加上才用） | Codex 自带的网页搜索 | 没有：设置页会提示 |

DeepSeek 和 MiMo 不能搜索网页，这个任务里会跳过。没有可用的、能搜网页的 provider 时，卡片会说明并链接到 AI 设置。

其他 AI 任务仍然完全不带工具；见 [ai-providers.zh.md](ai-providers.zh.md) 和 [SECURITY.md](../SECURITY.md)。

### 怎么看结果

- **这家公司的薪资**：低于 / 接近 / 高于市场，或市场顶部，并给出典型薪资。
- **这个职位**：区间（类似 P10 到 P90 的范围和中位数，基本工资或总包），如果是基准货币的基本工资，还会显示它在你的基准组里
  的位置。
- **这家公司的相关职位**：来源里给出的其他区间。
- **来源**：带编号，每个数字都指向它们。“其他来源”表示不在你信任列表里的主机。

这是 AI 根据公开网页做的估算，不是这个岗位的事实。依赖它之前先看看来源。

## salary.yaml 一览

```yaml
benchmark:
  enabled: true          # 每轮采集后重建
  window_days: 365       # 只算这个时间窗内首次发现的岗位
  min_sample: 5          # 更小的组不保留
  include_ai_lookups: false
role_families:           # 第一个匹配的胜出；正则，不区分大小写
  - id: ml_engineer
    label: { en: ML / AI engineer, zh: 机器学习 / AI 工程师 }
    patterns: ['\b(?:machine learning|ml|ai|llm)\s+(?:engineer|developer)\b']
deep_links:
  - { id: levels_fyi, label: Levels.fyi, url: 'https://www.levels.fyi/companies/{company_slug}/salaries' }
lookup:
  enabled: false
  ttl_days: 30
  max_per_day: 10
  timeout_seconds: 300
  max_searches: 8
  allowed_fetch_domains: [levels.fyi, glassdoor.com, glassdoor.de, kununu.com]
  sanity_annual: { min: 5000, max: 2000000 }
  unconvertible_max_annual: 100000000000
  web_search_usd: 0.01
```

给岗位族的正则补上你所在市场语言的词（随产品发布的文件已经带了德语）。薪资网站链接的 URL 也能在设置页里改：它们只是你的
浏览器打开的链接，Job Radar 自己不会向它们发任何请求。必须是 `https://` 或 `http://` 开头的地址。

## 排查

| 卡片上写着 | 怎么办 |
|---|---|
| “这个标题不属于任何岗位族” | 在 `role_families` 里给它加一条正则 |
| “写明薪资的同类岗位太少” | 每个组的薪资都不到 `min_sample` 个：等更多岗位，或调低 `min_sample` |
| “这个查询设置的 AI provider 都不能搜索网页” | 把 `claude-cli` 或 `anthropic` 放进 `tasks.salary_lookup.order`，并确认它可用（`pnpm ai:probe`） |
| 登录失效、限流、超时 | provider 自己的问题；请求不会自动重试 |
| “ai-worker 一直没有响应” | ai-worker 没在运行或正忙：看 `/sources` |
| “薪资相关的数据表还不存在” | 运行数据库迁移（`pnpm db:migrate`，部署时会自动做） |
