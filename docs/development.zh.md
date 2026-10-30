# 开发指南

完整开发流程、命令与项目布局见[英文开发指南](development.md)。本页说明当前展示分数投影的开发约定。

## 当前展示分数投影

`scores` 是 AI 判断的权威来源。`job_current_scores` 是可重建的派生投影，展示规则位于
`src/lib/db/queries/job-cards.ts`。所有应用内分数写入函数要求 `ScoreTx`，由
`scoreTransaction(db, async (tx) => ...)` 创建。用 `tx.touch(ids)` 登记岗位，helper 在最外层回调返回后、提交前
统一刷新一次。嵌套调用使用保存点并共享登记集合；保存点回滚后多登记的岗位重新计算即可。不要提前刷新后继续写入。helper 在运行时拒绝未品牌化的外层事务；外层也必须改用 `scoreTransaction`。

分数事务持有的 `scores` 行锁要到提交前的刷新之后才释放，所以每个改动多行的写入都按 `scores.id` 升序取行锁
（`src/lib/db/repos/score-lock-order.ts`）：批量 UPDATE 用 `inScoreLockOrder(where)`（带排序的 `FOR UPDATE` 子查询）选行，
逐行更新先按分数 id 排序（`inScoreIdOrder`）。否则按岗位 id 写的事务和按扫描顺序写的事务会互相死锁。

刷新只支持 READ COMMITTED：先用独立语句按桶号升序取 advisory 锁，再用另一条语句的新快照计算。
SQL 锁函数拒绝更强的隔离级别。投影不建外键，刷新阶段不会等待岗位行锁。守卫测试检查 ORM 和字面 SQL 写入。
直接 SQL、COPY、级联删除、迁移和旧版本绕过 helper，由每轮 maintenance 发现并修复差异。

修改展示规则时，同一改动需要更新 TypeScript 规则、新增用规则冻结副本重建投影的迁移、补充独立期望值测试。
表不存在时的临时读回落在下一个 minor 版本删除；规则构造器仍供刷新和自检使用。
写入回调内读取投影只能看到刷新前的值，因为刷新在回调结束后执行。
