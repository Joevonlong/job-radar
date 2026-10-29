# Bright Data（LinkedIn 第一顺位通道）

通道 `linkedin-brightdata` 通过 Bright Data Web Scraper API 的"LinkedIn job listings — discover by keyword"取 LinkedIn 岗位。

## 账号与 key
1. 在 Bright Data 注册账号（免费档每月 5000 条，无需绑卡），到 Account settings 创建 API key。
2. 把 key 写进 `.env`：`BRIGHT_DATA_API_KEY=...`（`.env` 已 gitignore，不要提交、不要贴到聊天或日志里）。
3. 没有 key 时通道显示“未配置”：级联直接跳过它，不发请求、不记失败、不影响熔断，下一个 LinkedIn 通道接手。

## 配置（`data/config/sources.yaml` → `linkedin.brightdata`）
| 键 | 含义 |
|---|---|
| `enabled` | 开关 |
| `free_records_per_month` | 每月免费条数（默认 5000）；先用完它 |
| `cost_per_1k_usd` | 超出免费额度后每 1000 条的价格（默认 1.5；0 = 按免费处理） |
| `monthly_budget_usd` | 该通道每月最多花多少（只计免费额度之外）；全局上限见 `paid_total_monthly_budget_usd` |
| `dataset_id` | Bright Data 数据集 ID（`gd_lpfll7v5hcqtkxl6l`） |
| `poll_interval_ms` / `timeout_ms` | snapshot 进度轮询间隔 / 从触发到下载完成（snapshot 构建 + 下载）合计最长等待，默认 600000（10 分钟）。超时记为可重试的失败，并在日志里写出 snapshot id（供应商保留 30 天，可事后取回） |
| `country` | 城市查询的国家代码 |
| `remote_locations` | 远程查询按 `search.yaml: remote_scope` 取的 location |
| `max_results` | 单次查询最多条数（每个输入最多 100，Bright Data 的上限） |

## 它怎么工作
- 每个查询 = 一次 trigger：关键词组用 `"A" OR "B"` 合并（超过 200 字符自动拆成多个 input），× 一个城市（或远程 location）。
- 时间窗：≤ 24 小时 → `Past 24 hours`，≤ 7 天 → `Past week`，≤ 30 天 → `Past month`。比供应商档位更短的窗口（例如 10 小时）在本地按 `job_posted_date` 过滤；没有发布时间的岗位保留。只有日期的 `YYYY-MM-DD` 按天处理，仅在日期加 24 小时早于窗口起点时丢弃；ISO 时间戳仍按精确时刻比较。
- 用量按 snapshot 实际送达的条数记账：已计费的用量绝不丢弃，被本地时间窗过滤掉的、重复的也计入（它们不写入 raw_postings）。触发前按剩余免费条数和剩余美元换算出 `limit_per_input`，正常不会超预算；预算已空时直接 `budget_exceeded`，同一个查询改用级联里的下一个通道。如果供应商不遵守 limit、送来超出预算的 snapshot，这些记录照常入库、实际用量照实记账，之后该通道本月没有余量，后续查询由级联里的下一个通道接手。
- 数据集没有"远程/混合/到岗"字段，`workplace` 由 pipeline 读 JD 文字得出（见[岗位信息提取](extraction.zh.md)），读不到就是 `unknown`（不推测）。
- 描述：`job_summary` 是一整段纯文本，末尾带 "Show more Show less"；`job_description_formatted` 是带段落和列表的 HTML，已加进请求的字段，解析时优先用它。老的采集记录没有这个字段，由 pipeline 整理（`pipeline.yaml: description`）。

## 线上冒烟
```bash
pnpm smoke:brightdata            # 读 .env；一个查询，最多 10 条
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-brightdata.ts --limit 5
```
会消耗免费额度（供应商对冒烟和 dry-run 送达的每条记录一样计费）；不写数据库，用量只在输出里显示，不计入当月累计。数据库状态可读时，`pnpm cycle:run --dry-run` 先看本月已存的用量，达到预算上限就跳过该通道；供应商超出请求上限送达的记录照样计费。

## 备注
- 字段名以 `GET https://api.brightdata.com/datasets/<dataset_id>/metadata` 为准；请求了不存在的字段，trigger 会返回 500。
- 供应商返回 429 时不要立刻重试：Bright Data 会拉黑 5 分钟内累计 25 次 429 的 IP。trigger 不重试（重复 trigger 可能重复计费）。
