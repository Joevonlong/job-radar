# Apify（LinkedIn 第二顺位通道）

通道 `linkedin-apify` 在 Bright Data 免费额度用完（或失败）后接手 LinkedIn 主搜索，通过 Apify 上的 actor 取岗位。

## 账号与 token
1. 注册 Apify 账号（Free 套餐有每月赠送额度），在 Console → Settings → API & Integrations 复制 Personal API token。
2. 写进 `.env`：`APIFY_TOKEN=...`（`.env` 已 gitignore，不要提交、不要贴到聊天或日志里）。
3. 没有 token（或 `actor_id` 为空）时通道显示"未配置"，级联直接跳过它，不产生失败记录，也不影响熔断。
4. 到 `/settings` 的 channels 页确认 `linkedin-apify` 已启用（默认启用）；月预算 `monthly_budget_usd`（默认 10 美元）受全局 `paid_total_monthly_budget_usd` 约束。

## 配置（`data/config/sources.yaml` → `linkedin.apify`）
| 键 | 含义 |
|---|---|
| `enabled` / `monthly_budget_usd` / `throttle` / `max_results` | 同其他通道；`max_results` 是单个查询最多取多少条 |
| `actor_id` | （受保护：手动改文件）actor，`username/actor-name` 或 17 位 ID；默认 `valig/linkedin-jobs-scraper`；空 = 未配置 |
| `api_base_url` | Apify API 地址 |
| `price_per_1k_usd` / `run_start_usd` | 记账用：每 1000 条结果的价格、每次运行一次的启动费。以 actor 页面 Pricing 里你所在套餐的价格为准 |
| `memory_mb` / `timeout_secs` | 单次运行的内存和超时；同步接口上限 300 秒，超时记为可重试的失败 |
| `country_name` | 城市查询的地点 = `<城市>, <国家名>` |
| `remote_locations` | 远程查询按 `search.yaml: remote_scope` 用的 location |
| `date_posted` | actor 的"发布时间"过滤写法：窗口 ≤24 小时 / ≤7 天 / ≤30 天 / 更长（空 = 不带这个键） |
| `input_template` | actor 输入模板；字符串里可用 `{keywords}` `{location}` `{date_posted}` `{limit}`（整串是 `"{limit}"` 时变成数字），值为空的键会被省掉 |
| `remote_input` | 远程查询在模板上叠加的键（默认 `urlParam: f_WT=2`） |

`input_template`、`remote_input`、`date_posted` 在设置页不显示（actor 专用的数据），直接改 YAML。

## 它怎么工作

- **补窗：**Apify 始终保留基础窗口，暂不自动[补窗](sources.zh.md#补窗)，因为时间档位较粗、结果不按新到旧返回。
  只有在当前设置下能请求精确时间窗、按新到旧返回结果，并经实测确认后才会启用。将来的手动补抓若扩大窗口，
  每次查询可能取回更多记录，按条计费的费用也会增加。
- 每个查询 = 一次同步运行：`POST /v2/acts/<actor>/run-sync-get-dataset-items`（成功 201，超过 300 秒 408，没有额度 402）。关键词组用 `"A" OR "B"` 合并（超过 200 字符拆成多次运行，共用 limit）。
- 触发前按本月剩余预算算出这次最多能要几条（先扣启动费），并作为 `maxItems`/`maxTotalChargeUsd` 硬上限发给 Apify；预算不够一次运行 + 一条结果时直接 `budget_exceeded`，同一个查询交给级联里的下一个通道。
- 记账 = 启动费 + 实际送达条数 × 单价；已被计费的条数（含重复、被本地时间窗丢掉的）都计入通道月用量和全局付费上限。
- 运行只发一次，不重试（重试会重复计费）；连续失败 3 次熔断，24 小时后再试。
- `external_id` 是 LinkedIn 的数字 job id，和 Bright Data 一致，两个通道拿到同一个岗位会合并成一个。

## 发布日期与本地时间窗

请求窗口比 actor 的日／周／月过滤范围更窄时，通道还会在本地过滤。例如，10 小时查询先使用 actor 的日过滤，
再按本地 10 小时截点检查；24 小时查询依赖 actor 的日过滤，不另加本地截点。本地比较遵守 `postedDate` 的实际精度：

| 来源时间字段 | 本地比较方式 |
|---|---|
| 裸日期（`YYYY-MM-DD`） | 按天；只有给定日期整天都早于截点时才丢弃 |
| ISO 午夜，且 `postedTimeAgo` 的秒／分钟／小时描述与之吻合 | 按精确时刻 |
| ISO 午夜，相对描述缺失、无效、不支持、有冲突，或只有天／周精度 | 按天 |
| 非午夜 ISO 时间，相对描述缺失或与之吻合 | 按精确时刻 |
| 非午夜 ISO 时间，相对描述存在但无效、不支持或有冲突 | 按给定日期的天精度 |
| 日期缺失、无效或格式无法识别 | 保留；这些时间字段无法确认岗位在窗口外 |

相对描述以采集时刻和其单位检查：“5 hours ago” 表示至少 5 小时、不满 6 小时。它只用于核对精度，绝不换算成入库发布时间。
因此，`2026-10-26T00:00:00.000Z` 同时带有“1 minute ago”时，只要给定日期与窗口重叠，就仍可保留。
原始 payload 保持不变。只有有效的完整日历日期和 ISO 时刻才会写入 `postedAt`：裸日期按 UTC 午夜入库，
ISO 时间保存原来的时刻。`2026-10`、`2026-02-30` 等不支持或无效的日期会让 `postedAt` 保持未知（`null`）。
按天延伸到日末仅用于过滤。相对描述的精度处理只适用于 Apify；日期校验与 Bright Data、Monid 共用。

## 线上冒烟
```bash
pnpm smoke:apify              # 读 .env；一个查询，最多 10 条，约 $0.005
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-apify.ts --limit 5
```
会花 Apify 账户的钱；不写数据库，用量只在输出里显示。
