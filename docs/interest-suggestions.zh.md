# 感兴趣清单的每周建议

> **会发送什么：**为了生成建议，你标记过的岗位（每个的职位名、公司、JD 文本和你的状态）以及你的偏好，会发给你已打开的 AI 提供方。在 `schedule.yaml` 里用 `suggest.enabled: false` 关掉每周运行。见 [privacy.zh.md](privacy.zh.md)。

每周一次，AI 看你标过**感兴趣 / 准备中 / 已申请 / 面试中 / Offer** 的岗位（还有被你**忽略**的，用来对比），提出三类建议：新的**信号词**（T2 / T3 / T4 / 福利标签）、值得**关注的公司**、**筛选条件**（排除关键词、增加城市、排除公司）。建议只是提案，放在 `/interests` 的"学习建议"区块；**你点批准才写进** `data/config/interests.yaml` 或 `data/profile/preferences.yaml`，不批准就什么都不会变。

## 怎么跑
- runner 按 `data/config/schedule.yaml` 的 `suggest.cron`（默认周一 08:00，按 `timezone`）留一个 `run_suggest` 请求（control request），由跑 AI 的进程执行（runner，或宿主机上的 ai-worker）。runner 启动时如果错过了最近一次、又开着 `catch_up`，会补一个请求。
- `/interests` 的"现在就找建议"按钮可以随时手动触发；`/settings` 的最近请求列表里能看到结果。
- 命令行验证：对着一个**数据库副本**跑 `pnpm suggest:smoke --confirm-write <库名>`（会写 `interest_suggestions`，不改任何配置文件，不发 Telegram）。
- 喜欢的岗位少于 `min_positive_jobs`（默认 3）时不调用 AI，`/interests` 会显示"感兴趣的岗位太少"。

## 每条建议都带证据
- 信号词：至少 `min_evidence.signal_word` 个**你喜欢的**岗位里出现，每个附一句 **JD 原文引用**；引用必须是该岗位 JD 里逐字存在的片段（空白不计），词本身必须在引用里，找不到的引用整条丢弃。已经在清单里的词（或已被某个 pattern 覆盖的）不再建议；在被忽略的岗位里和在喜欢的岗位里一样常见的词也不建议。
- 关注公司：附该公司你喜欢的岗位（公司名按去掉 GmbH、别名之后的写法匹配），存的是数据库里的公司名。
- 筛选条件：排除关键词必须出现在你忽略的岗位里、且**没有任何喜欢的岗位**含这个词（硬过滤会连它们一起滤掉）；增加城市必须是喜欢的岗位所在城市；排除公司不能是你喜欢过的公司。
- AI 的把握低于 `min_confidence` 的丢弃；每次最多存 `max_suggestions` 条（把握高的优先）。

## 不重复
每条建议有一个去重键（词按大小写和空白折叠、不分档位；公司按规范化名称）。同一条无论待审批、已批准还是已拒绝，都不会再提。**拒绝 = 以后不再出现。**

## 批准之后
- 写回用 `writeConfig`（YAML 注释保留、原子替换、zod 校验）。词进对应档位的 `keywords`（福利标签进 `benefit_tags`），公司进 `watched_companies`，筛选条件进 preferences.yaml（会存一份画像快照，相关分数标记为过期并重新打分）。
- 立即重算排序值（`reconcileBonuses`，不调用 AI）；新词要等下一轮 `signals` 步骤按新词表重新扫描 JD 才开始计分（页面会这样提示）。
- 配置文件读不了或写不进时，建议回到待审批，什么都不丢。
- 值已经在清单里（你手动加过）：标记为已批准，不改文件。

## Telegram
有新建议时每周一条消息（`suggest.notify` 和 `notify.yaml` 的 `telegram.enabled` 都开着；落在静默时段就不发，建议仍在页面里）。消息列出前几条，附 `/interests` 链接（需要 `notify.yaml` 的 `public_base_url`）。

## 配置项（schedule.yaml 的 `suggest`）
`enabled`、`cron`、`lookback_weeks`、`positive_statuses`、`ignored_statuses`、`min_positive_jobs`、`max_positive_jobs`、`max_ignored_jobs`、`jd_max_chars`、`max_suggestions`、`min_confidence`、`min_evidence`、`max_term_chars`、`notify`。这些没有设置页表单，直接改 YAML（runner 热加载）。
