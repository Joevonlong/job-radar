# JSearch（Google for Jobs，RapidAPI）

通道 `jsearch` 通过 JSearch API 取 Google for Jobs 聚合的岗位，补充 LinkedIn 和 ATS 之外的、尤其是只发在公司官网的岗位。它属于聚合源（家族 `google`，原帖链接优先级 4）：同一个岗位在别的通道里有更高优先级的链接时，以那个为准；但岗位本身的原帖链接（“查看原帖”打开的链接）会先在 JSearch 返回的多个链接里挑最好的（见下）。

## 账号与 key
1. 在 RapidAPI 订阅 JSearch（<https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch>，供应商 OpenWeb Ninja）。免费档每月 200 次请求（硬上限，不绑卡）；付费档见套餐页（Pro 10000 次/月，超出每次 $0.003，写文时的价格）。
2. 把 RapidAPI 的 key 写进 `.env`：`JSEARCH_API_KEY=...`（`.env` 已 gitignore，不要提交、不要贴到聊天或日志里）。
3. 在 `data/config/sources.yaml` 把 `sources.jsearch.enabled` 改成 `true`（或在设置页的"通道"标签里打开）。
4. 没有 key 时通道在 `/sources` 显示"未配置"，一个请求也不发，也不算失败。

## 配置（`data/config/sources.yaml` → `sources.jsearch`）
| 键 | 含义 |
|---|---|
| `enabled` | 开关（默认关） |
| `api_base_url` | `https://jsearch.p.rapidapi.com`；它的域名同时作为 `X-RapidAPI-Host` |
| `country` / `language` | `country=de`；`language` 留空 = 该国主要语言 |
| `pages_per_query` | `num_pages`：每个查询读几页（每页 10 条，**每页算一次请求**） |
| `keywords_per_query` | 每个关键词组取前几个词各查一次（Google for Jobs 没有可靠的 OR）。默认 1 |
| `monthly_request_limit` | 套餐每月包含的请求数（免费档 200）；用量按"请求数"记在通道的月用量里（`/sources` 的进度条），用完后通道不再发请求 |
| `overage_cost_per_request_usd` | 超出 `monthly_request_limit` 后每次请求的价格；0 = 超出后一律不发。大于 0 时按这个价格计入 `monthly_budget_usd`，预算不够就停 |
| `monthly_budget_usd` | 只计超出 `monthly_request_limit` 之后的花费（不能超过 `paid_total_monthly_budget_usd`） |
| `pace_requests` | 把月请求数按日历均摊（月初第 N 天最多用 `ceil(limit × N / 当月天数)` 次），避免月初几轮把额度用完 |
| `fetch_details` / `max_details_per_query` | 搜索结果没有正文时才取 `/job-details`（一次最多 20 个 id，每个 id 算一次请求）。默认关 |
| `apply_publisher_preference` | 没有官网直链时，原帖链接（“查看原帖”打开的链接）按这个发布者顺序挑（不区分大小写，子串匹配），不在表里的排最后 |
| `rate_limit_retries` | 每秒 / 每分钟限流（429）后最多再试几次，每次先等一个 `throttle` 间隔 |
| `throttle`、`max_results` | 与其他通道相同 |

## 它怎么工作

- [补窗](sources.zh.md#补窗)可能把 `date_posted` 扩到 `3days`、`week` 或 `month`。结果更多时，详情请求也可能增加，
  但每个查询仍不超过 `max_details_per_query`。请求节奏、按月均摊和配额规则不变。
- 每个查询 = `search.yaml` 的一个关键词组 × 一个城市（或远程）。请求：`GET /search?query=<关键词> in <城市>&page=1&num_pages=N&country=de&date_posted=today|3days|week|month`；远程查询不带城市，加 `work_from_home=true`。`date_posted` 取能覆盖回看窗口的最小档（≤24h today，≤72h 3days，≤168h week，其余 month）。
- **关注公司：**[公司查询](sources.zh.md#关注公司查询)是一次请求 `GET /search?query=<公司> in <本国>`，不带 `work_from_home`，与其他查询一样计入 `monthly_request_limit`。开启 `fetch_details` 时，只为被搜公司或其他关注公司的岗位请求 `/job-details`（每个详情 id 都是一次计费请求）。在本块设 `company_queries: false` 可关闭。公司查询与关键词查询共用 `monthly_request_limit`，可能把后者挤掉：免费档（每月 200 次请求）下，7 家公司按 24 小时间隔就要约 210 次；见[共用预算](sources.zh.md#关注公司查询)。
- 默认一轮 = 3 个关键词组 × (2 个城市 + 远程) = 9 次请求。免费档每月 200 次，所以默认只查每组第一个关键词，并按月均摊；想多查就升级套餐，再调大 `keywords_per_query` 和 `monthly_request_limit`。
- 响应兼容两种信封：RapidAPI `/search` 的 `data: [...]` 和 OpenAPI 文件里 `/search-v2` 的 `data: { jobs: [...] }`。没有 `job_id` 的记录丢弃，缺标题 / 公司的记录原样入库、由流水线标 `parse_failed`。
- 原帖链接（“查看原帖”打开的链接）：直链优先——API 标 `is_direct`、域名是雇主官网（含子域名）、或官方 ATS 看板地址（Greenhouse / Lever / Ashby / Personio / SmartRecruiters）；其余按 `apply_publisher_preference` 排序，再按 API 顺序。链接里的 `utm_*`、`gclid` 等追踪参数会去掉（原始记录不动）。`sourceUrl` 是第一发布者的岗位页（它 404 表示岗位已下线），不是 Google 的面板链接。详情页的“查看原帖”对 JSearch 来源优先用上面挑出的链接（`apply_url`），不用第一发布者的岗位页；这和公司 ATS 来源相反（ATS 优先岗位页，避免打开申请表单）。
- 薪资：`job_min_salary` / `job_max_salary` / `job_salary_period`；API 不带币种，从薪资文字里的 € / £ / $ / CHF / EUR 等识别（也接受 `job_salary_currency`）；识别不出就只保留文字、不给结构化薪资（不推测）。
- 远程：`job_is_remote: true` → `remote`；AI 增强字段 `work_arrangement` 存在时优先用；`false` 只说明"不是全远程"，记为 `unknown`。
- `isAgency` 不填（JSearch 不说明）；中介判断由流水线的 `agency_names` 规则做。
- 已存的描述会保留：搜索结果没有描述、这次又没拿到带描述的详情的岗位（详情关着、详情请求失败或被拒、排在 `max_details_per_query` 之外，或查询提前结束），沿用以前某一轮存下的描述；存下的详情本身没有描述时不沿用。只沿用描述：地点、薪资、投递链接、发布时间等其他原始字段一律以本次搜索为准。从描述推断的内容（远程 / 现场、搜索没给的薪资、合同类型、语言）可能跟着这份旧描述走，与平时带描述的岗位相同。这次拿到带描述的新详情时照旧使用新详情，旧描述不再沿用。

## 用量与熔断
- 一次请求（一页）= 1 条用量；失败的请求不记。成功后才记账，所以 5xx 重试不会多记。已经得到回应的请求一律完整记账，即使这时别的通道刚好用完了全局付费额度（之后的检查会拒绝更多请求）。
- `429`：响应体（或 `x-ratelimit-requests-remaining: 0`）说月配额用完 → 不重试，**立即熔断**（`circuit_breaker.cooldown_hours` 后试探一次）并走现有的"通道已熔断"Telegram 告警；说每小时 / 每天限额 → 不重试，本轮不再试，计一次失败；其他（每秒限流）→ 等一个 throttle 间隔后重试 `rate_limit_retries` 次，仍失败算一次可重试失败。
- `401` / `403`（key 无效或没订阅 JSearch）→ `auth_expired`，触发"凭据失效"告警。
- 月用量用完 / 按月均摊的份额用完 → `budget_exceeded`，这一轮剩下的查询跳过；不算失败、不熔断。开启查询轮换时（默认），下一轮先跑等待中的查询。已经花了额度的截停，即使零结果也算轮到；第一个请求前就被拒绝则不算。
- `keywords_per_query` 大于 1 时，一个查询对每个关键词各发一次请求，后面的关键词可能让查询提前结束：
  - 它的请求失败（网络错误、429、key 被拒（401/403））：前面的关键词交出至少一条岗位时，这些岗位保留，这次运行记为"中途中断"，算失败，和别的失败一样计入熔断和失败来源；一条都没有就是普通失败。这样失败之后不再请求岗位详情。
  - 请求发出之前被月用量或按月均摊的份额拒绝：已读到的岗位入库，这次运行记为"跳过"，日志里有 `jsearch budget reached mid-query`。不增加失败次数、不熔断，但这也不算完整查完，所以这次运行不用来判断岗位是否可能已关闭。同一通道的其他完整运行，只要窗口没有扩大（即使是同一轮里更早的查询），仍会计入：这个判断按通道、按时间，不按查询（见[数据源](sources.zh.md#岗位怎样被标为可能已关闭)）。第一个关键词就被拒时，整个查询照旧跳过。
- 月用量按日历月（`schedule.yaml` 的时区）统计，RapidAPI 按订阅日起算的计费月可能不同：以 RapidAPI 面板为准，必要时调 `monthly_request_limit`。

## 线上冒烟
```bash
pnpm smoke:jsearch                 # 读 .env；一个查询 = 1 次请求
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-jsearch.ts --remote
```
不写数据库，用量只在输出里显示，不计入当月累计。也可以用 `pnpm cycle:run --channel jsearch --dry-run`：请求数由查询数、`keywords_per_query` 和剩余额度决定。数据库状态可读时，试跑先看本月已存的请求数；额度用完且没有配置超额单价时不再发请求，配置了单价也要美元预算有余量才能继续。

## 备注
- 供应商新文档（<https://www.openwebninja.com/api/jsearch>）把 `/search-v2`（游标分页，`x-api-key` 头，域名 `api.openwebninja.com`）列为当前搜索接口；本通道走 RapidAPI 的 `/search`。字段名两者一致。要切到直连，需要改认证头和分页，属于单独的改动。
