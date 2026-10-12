# AI 用量统计

每次 AI 调用都在 `ai_usage` 里留一行，`/sources/ai-usage` 把它们按时间范围汇总。本篇说明记什么、怎么算、怎么用，以及**要加的配置**。

## 记什么

每次请求模型（含输出不合格后的重试、超时和报错）一行；被取消的、被路由跳过的（冷却、关闭、超预算）不算调用，不记。

| 列 | 含义 |
|---|---|
| `model` / `model_source` | 回复里报的模型名；`call` = 调用报告或我们指定；`cli_default` = codex 没指定模型，按 `models.yaml` 里标 `cli_default` 的那个认定；`assumed` = 旧版本给旧记录认定的模型。旧记录和未知模型为空 |
| `tokens_in` / `tokens_out` | 全部输入 / 输出（输入含缓存读写，输出含推理）；**空 = 服务商没报告，不是 0** |
| `tokens_in_cached` / `tokens_in_cache_write` / `tokens_out_reasoning` | 上面两个数的子集；空 = 没细分 |
| `duration_ms` | 一次模型调用的耗时 |
| `outcome` / `error_kind` | `ok` / `invalid_output` / `failed`；失败行有错误种类（超时、限流、登录失效、网络、服务商报错…）。不存错误原文 |
| `cost_estimate` | **实际开支**：API 按 `price`，订阅 = 0；月预算只加这一列 |
| `equivalent_cost_usd` | **折合 API 费用**：同样的 token 按 API 价目表要付多少。API 调用 = 实际开支；订阅 CLI = 按 `equivalent_price`；没有单价或 token 未知 = 空 |
| `job_id` | 打分、信号、翻译调用对应的岗位（岗位删除后置空） |

两种费用都在**写入时**按当时的 `models.yaml` 算好存下；以后改价格不会改写历史。迁移前的旧行新列都是空（页面上叫"旧记录"）。

打开理由来源（`ai.yaml: scoring.evidence`）后，每次打分为每条理由多写一个来源和一段短引用，输出 token 会变多。对比打开前后 `score` 任务的输出 token 中位数即可；这些调用仍记作 `score`。见 [score-evidence.zh.md](score-evidence.zh.md)。

## 价格：`price` 和 `equivalent_price`

- `price`：只给 API 服务商，真实计费，参与月预算。可加 `cached_input_per_mtok`（缓存命中的输入）、`cache_write_per_mtok`（写入缓存的输入）；不写就按 `input_per_mtok` 算（和以前一样偏保守）。
- `equivalent_price`：只给订阅 CLI（claude-cli / codex-cli），只用于统计，永远不参与预算。键同 `price`，另外**必须写 `source`**（出处和日期）。API 模型写它会被 `pnpm config:check` 拒绝。
- 计价：`(输入 − 缓存读 − 缓存写) × 输入价 + 缓存读 × 缓存读价 + 缓存写 × 缓存写价 + 输出 × 输出价`。
- 不用 CLI 自己估的费用（claude 的 `total_cost_usd`）当折合费用，口径统一用目录里的 `equivalent_price`；可以拿 `claude -p --output-format json` 输出里的 `total_cost_usd` 核对单价是否填对。
- 所有金额是美元，不换算其他货币。

## 页面 `/sources/ai-usage`

只读、不发起任何 AI 调用。时间范围（今天 / 7 天 / 30 天 / 本月 / 自定义，按 `schedule.yaml` 的时区，含今天）、筛选（点三张明细表的行，标签上 ✕ 移除）、指标、页码都在 URL 里，刷新和分享链接都保留。

- 汇总：折合 API 费用、实际开支、节省（折合 − 实际，只算有折合费用的调用）、调用、Token。没有 token 数或没有折合单价的调用不计入合计，并在块下写明有多少次。
- 按天堆叠图（按服务商）、按模型 / 服务商 / 任务三张表、单次调用明细（岗位标题链到 `/jobs/<id>`）。
- 缓存 / 推理 token 是未知（旧记录没有这两列）时不写 0：汇总和明细表写"已知合计 + N 次未知"，全部未知时写"未知"；金额一律写 `$`（中英文页面相同）；点"自定义"时日期框预填页面当前的时间窗口；折合费用缺失的脚注把"模型未知"和"模型没有折合单价"分开。
- "导出 CSV"：当前范围和筛选下的明细，最多 `csv_max_rows` 行（最新的优先），UTF-8 带 BOM，未知值是空单元格。
- 设置在 `data/config/ui.yaml` 的 `ai_usage` 块（默认范围、自定义最长天数、明细每页行数、CSV 上限）；文件里没有这块也能运行。

## 要加的配置

严格 schema 的旧代码不认识 `equivalent_price`、缓存单价和 `ui.yaml` 的 `ai_usage`：如果文件里已经有这些新键、但能识别它们的代码还没在运行，ai-worker 会读不了目录（API 服务商被跳过）、设置页报错。顺序：升级并部署新代码（`scripts/ops/deploy.sh`）→ 把下面两块加进文件 → `pnpm config:check` → 单独提交这次配置改动。回退时先撤这个配置改动。

### `data/config/models.yaml`（在对应模型条目里加 `equivalent_price`，其余不动）

单价已在 2026-10-08 对照官方价目表核对：Anthropic（https://platform.claude.com/docs/en/about-claude/pricing）；OpenAI（`gpt-6.1-sol` 标准价，来自 OpenAI 的模型页 / 定价页，经搜索结果核对）。**注意**：Sonnet 5.5 的缓存读是 $0.10（输入价的 0.05 倍，不是 Sonnet 5 的 $0.20）。

```yaml
  claude-cli:
    label: Claude Code CLI
    models:
      - id: claude-haiku-4-5
        label: Claude Haiku 4.5
        equivalent_price: { input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25, source: "Anthropic API pricing (5 min cache write), platform.claude.com, checked 2026-10-08" }
      - id: claude-sonnet-5-5
        label: Claude Sonnet 5.5
        equivalent_price: { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5, source: "Anthropic API pricing (5 min cache write), platform.claude.com, checked 2026-10-08" }
      - id: claude-opus-5-5
        label: Claude Opus 5.5
        equivalent_price: { input_per_mtok: 4, output_per_mtok: 20, cached_input_per_mtok: 0.2, cache_write_per_mtok: 5, source: "Anthropic API pricing (5 min cache write), platform.claude.com, checked 2026-10-08" }
  codex-cli:
    label: Codex CLI
    models:
      - id: gpt-6.1-sol
        label: GPT-6.1 Sol
        cli_default: true
        equivalent_price: { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5, source: "OpenAI API pricing, standard tier (prompts up to 272K), openai.com / developers.openai.com, checked 2026-10-08" }
```

可选：给 `anthropic` 两个模型的 `price` 补缓存单价（现在的 anthropic 调用没开缓存，补不补结果一样）：Haiku 4.5 `cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25`；Sonnet 5.5 `cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5`（按 `config/models.yaml` 里实际写的模型核对；改的是你的副本 `data/config/models.yaml`，要先复制发布的文件，它会整份替换发布的列表）。

### `data/config/ui.yaml`（文件末尾加）

```yaml
# AI 用量页（/sources/ai-usage）：只影响这个页面的显示
ai_usage:
  # 打开页面时默认的时间范围：today | 7d | 30d | month（本月）
  default_range: 30d
  # 自定义范围最多多少天
  custom_max_days: 366
  # 调用明细每页多少行
  log_page_size: 50
  # "导出 CSV" 最多导出多少行（超出时只导出最新的这么多行）
  csv_max_rows: 20000
```

## 排错

- 汇总里"N 次调用没有 token 数"：CLI 的回复里没带用量（格式变了或该模型不报），按设计记为未知；升级 CLI 后重录 `tests/fixtures/ai/` 下的夹具。
- "N 次调用的模型没有折合单价"：在 `models.yaml` 给这个模型补 `equivalent_price`。它只对新的调用生效，旧行保持空值。
- `pnpm ai:probe` 每行会多打印缓存 / 推理 token、耗时、折合费用（`equiv≈`）。
