# Tavily 搜索（ATS board 发现）

通道 `tavily` 用 Tavily Search API 找"还不在 `sources.yaml 的 ats_boards` 里的公司招聘页"（Greenhouse / Lever / Ashby / Personio / SmartRecruiters）。它不采集岗位，只把新找到的 board 写进候选表，在 `/sources` 的"发现的 board"里由你一键加入或忽略。它取代了 Brave Search，职责完全相同；`brave` 通道还在，默认关闭。

## 账号与 key
1. 在 <https://app.tavily.com> 注册（不用绑卡）。免费档每月 1000 个额度；用完后可以改按量付费（写文时约 $0.008 / 额度，以官网为准）。
2. 在控制台复制 API key（以 `tvly-` 开头）。
3. 写进 `.env`：`TAVILY_API_KEY=tvly-...`（`.env` 已 gitignore，不要提交、不要贴到聊天或日志里）。`.env.example` 里只有空占位。
4. 重启 runner（`scripts/ops/deploy.sh`，或让容器重新读取 `.env`）。`sources.tavily.enabled` 默认就是 `true`，不用改配置。
5. 没有 key 时通道在 `/sources` 显示"未配置"，doctor 的「通道 tavily」是 ⚠️ 并点名 `TAVILY_API_KEY`；一个请求也不发，也不算失败。

## 额度
- 一次搜索花 1 个额度（`search_depth: basic`，也包括 `fast`、`ultra-fast`）；`advanced` 花 2 个。
- 默认每天最多搜索一次（`interval_hours: 24`）、每次最多 30 次搜索（`max_queries_per_run`）：一个月约 900 个额度，在免费的 1000 个以内。
- 用量按日历月（`schedule.yaml` 的时区）记在通道的月用量里（`/sources` 的进度条）；用完 `monthly_credit_limit` 后通道不再搜索，不算失败、不熔断，下个月自动恢复。想超出免费额度：把 `credit_cost_usd` 设成单价（约 0.008），并给 `monthly_budget_usd` 一个上限，超出部分才会按美元计入预算。
- Tavily 返回 `432`（套餐额度用完）或 `433`（按量付费上限）时，本轮立即停止并熔断；在控制台调高上限后，熔断冷却期过了会自动试探。

## 配置（`data/config/sources.yaml` → `sources.tavily`）
| 键 | 含义 |
|---|---|
| `enabled` | 开关（默认开）。不要和 `sources.brave.enabled` 同时开，会重复搜索 |
| `api_base_url` | `https://api.tavily.com`；请求 `POST /search`，`Authorization: Bearer` |
| `search_depth` | `basic`（默认）/ `fast` / `ultra-fast`：1 个额度；`advanced`：2 个额度、结果更相关 |
| `keywords_per_query` | 每个 `search.yaml` 关键词组取前几个词，用 OR 连成一个查询（默认 2） |
| `interval_hours` | 距上次发现不足这么多小时不再搜索（默认 24） |
| `max_queries_per_run` | 每次最多搜索多少次（ATS × 关键词组 × 城市）。默认 30 |
| `max_results` | 每次搜索取多少条（Tavily 上限 20） |
| `monthly_credit_limit` | 套餐每月包含的额度（免费档 1000），也是月用量进度条的分母 |
| `credit_cost_usd` | 超出上限后每个额度的价格；0 = 超出后一律不搜 |
| `monthly_budget_usd` | 只计超出 `monthly_credit_limit` 之后的花费（不能超过 `paid_total_monthly_budget_usd`） |
| `throttle` | 两次搜索之间的间隔 |

## 它怎么工作
- 每个查询 = 一个 ATS × `search.yaml` 的一个关键词组 × 一个城市。例如 `KI Engineer OR KI-Entwickler jobs München`，`include_domains` 为该 ATS 的主机（`jobs.lever.co`、`jobs.eu.lever.co`；Personio 是 `jobs.personio.de`）。Tavily 没有 `site:` 运算符，主机限制靠 `include_domains`。
- 结果里的每个网址都要通过 `boardFromUrl`（只认五家 ATS 的官方主机和路径），其他网址一律丢弃；已经在 `sources.yaml 的 ats_boards` 里的 board 不再提示。
- 通道从不修改 `sources.yaml 的 ats_boards`；候选在 `/sources` 里点"加入"才会写进去。

## 换回 Brave
`sources.tavily.enabled: false`，`sources.brave.enabled: true`，并在 `.env` 里设置 `BRAVE_SEARCH_API_KEY`（<https://brave.com/search/api/>，免费档每月 2000 次）。

## 线上冒烟
```bash
pnpm cycle:run --channel tavily --dry-run   # 和真实运行一样，本月额度用完就停，除非配置了 credit_cost_usd 且预算还有余量
```
数据库状态可读时，试跑从本月已存的用量开始。只打印候选，不写数据库，仍不读、也不更新运行标记（`interval_hours`）。Tavily 那边会扣额度。需要确认：`include_domains` 对 Personio 子域名是否匹配、候选里确实有新 board。
