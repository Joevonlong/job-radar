# 查询性能验证

[English](query-performance.md) | [中文](query-performance.zh.md)

硬过滤在对应快照的 score 行里保存实际评估的岗位、公司、覆盖决定和配置指纹。每轮只读指纹变化或缺少结果的
候选。配置包含偏好、解析后的 pipeline/市场、用户语言和签证资料、公司关注名单；岗位内容、公司编辑、覆盖决定
变化使输入指纹失效。新快照独立产生结果。显式单岗重评仍立即运行，也支持 dormant；closed 仍排除。超时的一票
否决判断下一轮重试。`evaluated`、`passed`、`filteredOut`、`byReason` 只统计本轮真正评估的岗位，AI 分数字段和
score 创建时间保持不变。

描述、描述非空状态、薪资和旧 payload 指纹采用存储型生成列，保留原表达式及空 payload hash 的回退语义，不转换
已有哈希的算法。信号、trap、ghost、签证候选读取窄列。Trap 来源按候选岗位聚合，单岗检查不再聚合所有来源。
小型组合指纹和来源列表指纹仍在读取时计算。普通岗位读取和插入返回值不带全文搜索向量及内部生成指纹。
未变原始帖 upsert 保留已有 payload 引用，照常刷新元数据。

来源历史改成每通道限量的 lateral 查询，保留开始时间、id 倒序的并列规则。月度用量和运行数以本地月初为包含
下界、下月月初为排除上界。SQL 用边界前后各 24 小时的 UTC 包络走索引，再以本地时间精确判断，
保留月初重复/跳过午夜甚至非连续月份的语义。新增索引匹配最近/成功通道运行、
月份时间窗、通知岗位 id、单岗控制请求、pending 原始 id。既有索引保留；删索引需要运行实例的统计。

## 迁移与验证

通过 `pnpm db:generate --name incremental_scan_inputs` 在 `0039_job_dormant` 后生成
`0040_incremental_scan_inputs`：四个生成列、两个过滤缓存列和六个索引，没有新配置键。迁移重写 jobs/raw 表并持有
表锁；下述种子上实测 20.3 秒。首次过滤补齐缺失指纹，稳态数字不包含这次工作。

[performance-baseline.ts](../tests/integration/performance-baseline.ts) 固定保存 main `914dc3e` 的旧 SQL，已包含
dormant 和岗位身份修复。完整结果等价对照覆盖缺失/有效/过期扫描、空值/空白/中文描述、旧 payload、多来源/无来源、
closed/dormant、显式范围、分页、时间并列和月份边界（包括 Havana、Asuncion、Goose_Bay 的特殊午夜变更）。独立回归检查覆盖重复过滤跳过、未变 TOAST chunk id 保留、
返回值不带搜索向量、运行查询限量、月份条件可用索引、索引键可用。最初九个回归测试都实际在旧代码上执行并按预期失败。

受影响文件在 `tests/integration/`：`performance-queries`、`performance-equivalence`、`filter-incremental`、`filter`、
`signals`、`salary-signals`、`traps`、`ghost`、`visa`、`sources`、`ai-usage`、`dormant-hot-paths`、`pipeline`、
`pipeline-idempotence`、`notify`，使用正常的一次性 Postgres 17 测试库。交接另报实际数量、lint、typecheck；不运行
完整集成/e2e，也不连接生产库。

## 一年种子实测（2026-10-28）

指定种子参数 `40000 410 45 0.25`，固定 Postgres 随机种子，使用随附地点生成器、DE 资料和 `windows.sql`。
前后均先应用当前 main 的 dormant 策略：共 40,000 岗位（active 2,584，possibly_closed 27,990，其中 dormant
25,319；closed 9,426）、52,000 原始帖、17,550 runs、21,076 AI 调用。原有 191,448 scores 在两版预热当前快照后
都是 196,703。前后使用同一测试库；除注明外，预热一次后取五次中位数，均为本机合成测量。

| 操作 | 当前 main | 修复后 | 结果 |
|---|---:|---:|---|
| 信号候选 | 358.8 ms | 28.1 ms | 都为 0 个过期岗位 |
| 薪资同步 | 502.3 ms | 25.4 ms | 都为 0 个过期岗位 |
| Trap 候选 | 355.6 ms | 75.3 ms | 都为 0 个过期岗位 |
| Ghost 候选 | 159.4 ms | 84.6 ms | 都为 0 个过期岗位 |
| 签证候选 | 92.0 ms | 23.7 ms | 都为 0 个过期岗位 |
| 稳态硬过滤 | 444.8 ms | 66.8 ms | 评估 5,255 → 0，结果未变 |
| 每通道最近十次运行 | 15.9 ms | 3.2 ms | 相同的 15 个通道组 |
| 月度 AI 花费 | 11.1 ms | 2.2 ms | 总额相同 |
| 月度 AI 用量 | 11.1 ms | 2.2 ms | provider/task 分组相同 |
| 月度运行总计 | 9.3 ms | 2.0 ms | 相同的 15 个通道组 |
| 单岗读取 JSON 字节数 | 7,368 B | 4,383 B | 业务字段相同，减少 40.5% |
| 未变原始帖 upsert，1,000 行，单次 | 193.8 ms / WAL 2,130,096 B | 179.4 ms / WAL 1,452,904 B | payload、元数据语义相同 |

索引专项用事务删除/回滚恢复六个新索引；pending 查询临时把 514 行设为 pending，之后恢复。

| 查询 | 无新增索引 | 有新增索引 | 执行计划及共享缓冲命中块 |
|---|---:|---:|---|
| 通知岗位 id | 2.98 ms | 0.43 ms | 顺序扫描 → 表达式索引；520 → 19 块 |
| 不存在的单岗请求 | 1.03 ms | 0.31 ms | 主键倒扫 → 岗位 id 索引；95 → 2 块 |
| 接下来 50 个 pending id | 2.18 ms | 1.84 ms | 排序 → 有序部分索引；215 → 26 块 |

单岗读取耗时 1.06 → 1.33 ms；只证明传输减少，没有宣称单岗延迟改善。已推翻的 possibly-closed 批量更新子项，
以及 main 已合入的 Today/dormant 优化均未重做。

完整原始数字见 [query-performance.json](query-performance.json)。验证：受影响集成 15 文件 205 项通过；控制请求 25 项通过；终审修正后重新验证直接受影响 6 文件 49 项通过；相关单元 245 项通过，lint、typecheck、文档链接及内部编号检查通过。终审发现的空描述区别和异常月初边界均补了红/绿回归，未留未解决的重大问题。
