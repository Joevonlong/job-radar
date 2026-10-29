# Monid（LinkedIn 第三顺位备用通道）

`linkedin-monid` 通过 Monid 的预充值 workspace 钱包搜索 LinkedIn 岗位。默认接口是
`apify /harvestapi/linkedin-job-search`，Monid 会把搜索关键词和地点转给背后的供应商。
默认级联是 Bright Data → Apify → Monid → session → guest。前面的通道没有预算或出现不可重试错误时让位；
可重试错误则结束本轮的这条查询，不向后让位。

## 账号和 key

1. 在 [Monid](https://app.monid.ai) 创建 workspace 并生成 API key。
2. 在 `.env` 写入 `MONID_API_KEY=...`，然后重启 web 和 runner（`docker compose up -d web runner`）。不要把 key 放进 YAML、Git、聊天或日志。
3. 按需给 workspace 钱包充值，并**在 Monid 后台设置 workspace 花费上限**。
4. 在 `/sources` 查看 `linkedin-monid` 卡片，在 `/settings` → channels 确认预算。

通道默认启用，但没有 key 时显示“未配置”，级联直接跳过，不记失败、不增加熔断次数。
Job Radar 不自动查询余额或充值；余额不足或钱包未激活时级联让位。key 只放在 bearer 请求头里，
请求不跟随重定向；默认只允许把凭证发送到 `api.monid.ai`（见[配置保护](configuration.zh.md)）。

## 配置

位置：`data/config/sources.yaml` → `linkedin.monid`。常规字段、价格和时间可在 `/settings` 修改。
`provider`、`endpoint` 和 `api_base_url` 是受保护键，只能手改文件。换成输出形状不同的接口还需要相应的解析器；
这个通道只支持 harvestapi 的 LinkedIn 岗位输出。

| 键 | 默认值 / 含义 |
|---|---|
| `enabled` | `true`；没有 `MONID_API_KEY` 不发请求 |
| `monthly_budget_usd` | `5`，不得高于 `paid_total_monthly_budget_usd` |
| `throttle` | 拆分运行之间等待 `{ min_delay_ms: 1000, max_delay_ms: 3000 }` |
| `max_results` | `300`，还受查询上限和剩余预算约束 |
| `api_base_url` | `https://api.monid.ai` |
| `provider` / `endpoint` | `apify` / `/harvestapi/linkedin-job-search` |
| `price_per_1k_usd` / `flat_fee_usd` | `1.0` / `0.001`，供本地估算；以接口当前价格为准 |
| `poll_interval_ms` | `5000` |
| `timeout_ms` | `300000`，之后请求停止 |
| `stop_grace_ms` | `60000`，请求停止后继续等待终态 |
| `country_name` | 空值使用市场的英文国家名，追加到城市后面 |
| `remote_locations` | `worldwide: Worldwide`；未写的本国 / 区域值跟随市场 |
| `date_posted` | `{ day: 24h, week: week, month: month, any: "" }`，空值省略输入键 |
| `input_template` | `jobTitles: ["{keywords}"]`、`locations: ["{location}"]`、`maxItems: "{limit}"`、`postedLimit: "{date_posted}"`、`sortBy: date` |
| `remote_input` | `workplaceType: [remote]`，远程查询时叠加到模板上 |

模板、远程覆盖和时间档位只在 YAML 中修改。关键词组按 `"A" OR "B"` 合并，过长时拆成多次运行。
最终输入必须恰好有一个非空标题、一个非空地点，以及等于本次预算上限的正整数 `maxItems`。
这个 actor 的零值表示不限分页，因此会在发送前拒绝。短于接口档位的时间窗还会在本地按 `postedDate` 过滤。
只有有效的完整日历日期和 ISO 时刻才会写入 `postedAt`。`2026-02-30` 等无效日期在采集和标准化时均记为未知（`null`），
原始 payload 原样保留。
远程方式只取岗位自身字段，只有发布者提供的薪资才进入薪资事实字段。
地区标签（如 EMEA）原样保留；国家代码必须是已分配的 ISO 3166-1 alpha-2 代码，优先采用解析后的地点代码，
`oo` 等占位符记为未知。

`POST /v1/run` 发送 `{ "provider": "apify", "endpoint": "/harvestapi/linkedin-job-search", "input": { "body": <actor input> } }`。
输入校验针对 `input.body` 内的 actor 输入本身；GET 运行响应也会回显这一层包装。Monid 还支持可选的
`input.queryParams` 和 `input.pathParams`，这个 actor 不需要它们。

## 记账与停止

**每次**发送前都按通道和全局剩余预算重新算条数，包含该次启动费。Monid 没有服务端的单次费用上限，
本地条数限制依赖配置价格估算；实际账单即使略超本地预算也照记，后台花费上限是另一道保障。

运行、inspect 及按条计费的 discover 价格采用嵌套金额对象：
`{ "type": "PER_RESULT", "amount": { "value": 0.001, "currency": "USD" }, "flatFee": { "value": 0.001, "currency": "USD" }, "notes": [] }`。
amount 是每条价格（每千条 1.0 美元），可选的 flatFee 是每次运行的启动费。允许额外字段，非 USD 金额不会当作
美元处理。正常成功运行可以只用 `cost: { value, currency: "USD" }` 和 `billedUnits` 结算，不带 `billing` 对象；
按上述价格，两条结果结算为 0.003 美元。

拿到终态先记账，再校验输出和解析岗位。条数取 `billedUnits`，缺失时取去重和本地过滤前的原始条数。
美元费用取同次运行所有响应中已结算的 `cost.value`、`billing.reportedCost`、`billing.actualCost` 的最大值，
包括停止返回的 409 响应体和后续 GET；`billing` 中的美元微单位要除以一百万。
没有观察到更高结算金额时，明确结算为零就保留零。只有从未观察到已结算金额时，
才使用最新有效的 `billing.calculatedCost`，并写警告日志；状态未知的响应也会提取费用。
费用缺失或格式错误时按计费条数或送达条数加启动费估算，成功空返回也计启动费。
失败、超时或无法确认终态且缺少结算金额和计费条数时，按请求条数上限保守记账；
`COMPLETED` 输出不是数组且没有可用费用或计费条数时，除非已确认有效的非 2xx、非 404 供应商错误，
否则按上限记账；`providerResponse` 缺失或无效时也保守记账。
正常收到的 `BLOCKED` / `STOPPED` 终态没有费用信息时本地记零；取消采集时，若所有响应中均未观察到
有效的已结算金额或计算费用，即使停止返回 `BLOCKED` / `STOPPED` 也按请求条数上限保守记账。

异步运行轮询到终态。超时后只发一次停止请求，再在 `stop_grace_ms` 内继续轮询；停止返回 409 也会重新查询，
因为它可能已完成，也可能仍在运行。完成的结果照常保留和记账。停止无法确认、或运行请求断线且拿不到结果时，
按请求上限保守记账，有 run ID 就写入日志。取消本轮采集时使用独立的短超时请求停止运行，
先记录结算金额或保守估算，再抛出取消。付费运行请求不自动重试。
拆分查询中后续运行失败或预算耗尽，前面已取得的岗位仍保留。

HTTP 502 映射为不可重试的 `unknown`、HTTP 503 映射为 `budget_exceeded`，适用于**初始运行请求**。
完整读取的 HTTP 503 拒绝响应表示执行前已被拒绝（例如钱包未激活），不计费。
其他 POST 5xx 响应（包括 502）且未观察到可用费用时，按请求条数上限保守记账。
POST 响应体读取失败或被截断时仍保守记账，包括 HTTP 503。
运行受理后，轮询的 HTTP 408、429 和 5xx 都是暂时性错误，先恢复运行结果或请求停止。
502/503 持续到超时及停止宽限期结束后，最终是可重试的 `network` 失败。
尚未请求停止时，若轮询出现不可重试错误，放弃前用独立的短超时请求尽力停止一次，保留原错误，费用只记一次。

解析失败的原文同样保留。取不到 LinkedIn job ID 时用稳定的 `unidentified:<sha256>` 隔离 ID 存储，
并标为 `parse_failed`，不会和正常 LinkedIn 岗位合并。

## 冒烟测试

```bash
pnpm smoke:monid --discover       # 只调 discover + inspect，没有付费运行
pnpm smoke:monid                  # 读取 .env；一个查询，最多 10 条
pnpm smoke:monid --limit 5 --group targets --location "Example City"
```

付费冒烟会扣钱包余额，按配置价格最多 10 条约 0.011 美元。不写数据库，也不计入持久化月用量。
输出条数、`billedUnits`、`cost`、全部 `billing` 字段（含 `calculatedCost`）、`runId`、`stoppable`、
输出形状和薪资来源标记。请对照 workspace 后台扣费记录，并核对 OR 标题是否符合搜索、`maxItems` 是否严格限制、
`output` 是否数组，以及 `salary.providedByEmployer` / `compensationSource` 的真实取值。
需要拆成多次运行的关键词组会被拒绝。`--discover` 独立解析目录中的每一项，跳过未知形状，列出 LinkedIn 岗位接口
的供应商与价格类型（包含矩阵、阶梯价格），按条计费时还输出单价和启动费，再逐一 inspect。
当前配置的接口即使不在发现结果中也会被 inspect。两种模式都会在其检查价格与 `price_per_1k_usd` /
`flat_fee_usd` 不一致时警告；按上述价格，这两个配置必须是 `1.0` / `0.001`。不支持的币种或计费模型会单独提示，
不会与美元估价直接比较。

## 升级、停用与回退

sources 配置迁移 **3 → 4**。已有 Monid 块保持原样；否则补上，预算为 `min(5, 全局上限)`，不改全局预算。
只有恰好是旧默认顺序的级联才在 Apify 后插入并启用 Monid。自定义顺序、子集或缺失的级联保持原样，
新块设为 `enabled: false`，需要时自行在 `/settings` 将 Monid 加入级联并启用。
迁移只跑一次，之后删掉级联条目不会加回来。要停用请保留配置块并设 `enabled: false`，
删除必需配置块会使当前配置无效。

只停用通道时设 `linkedin.monid.enabled: false`，无需回退代码。已启用但不在级联中的 LinkedIn 通道会被独立调度，
所以从级联删掉 `linkedin-monid` 并不能停用它。
代码回退到本版本之前，**先从 `data/config/.backup/<timestamp>/` 恢复 `sources.yaml`**；
也可以手动删掉 Monid 块和级联条目，把 `config_version` 改回 `3`。旧代码会拒绝版本 `4`。
部署脚本先迁移配置再切换服务，应避开采集时段；若迁移后部署失败，重启旧代码前先恢复备份。
见[配置指南](configuration.zh.md)。
