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
- 每个查询 = 一次同步运行：`POST /v2/acts/<actor>/run-sync-get-dataset-items`（成功 201，超过 300 秒 408，没有额度 402）。关键词组用 `"A" OR "B"` 合并（超过 200 字符拆成多次运行，共用 limit）。
- 触发前按本月剩余预算算出这次最多能要几条（先扣启动费），并作为 `maxItems`/`maxTotalChargeUsd` 硬上限发给 Apify；预算不够一次运行 + 一条结果时直接 `budget_exceeded`，同一个查询交给级联里的下一个通道。
- 记账 = 启动费 + 实际送达条数 × 单价；已被计费的条数（含重复、被本地时间窗丢掉的）都计入通道月用量和全局付费上限。
- 运行只发一次，不重试（重试会重复计费）；连续失败 3 次熔断，24 小时后再试。
- `external_id` 是 LinkedIn 的数字 job id，和 Bright Data 一致，两个通道拿到同一个岗位会合并成一个。

## 线上冒烟
```bash
pnpm smoke:apify              # 读 .env；一个查询，最多 10 条，约 $0.005
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-apify.ts --limit 5
```
会花 Apify 账户的钱；不写数据库，用量只在输出里显示。
