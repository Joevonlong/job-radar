# Telegram 推送

每轮处理完，宿主机上的 `ai-worker` 把合格的新岗位推到你的 Telegram（runner 只负责接收按钮回调，所以收不到消息时请先确认 ai-worker 在运行）；消息下面有 👍 感兴趣 / 🚫 忽略 / 📄 定制简历 三个按钮，点了就写进申请记录（和看板是同一份数据）；第二行还有一个 ⭐ 收藏，只加星标。runner 用 long-polling（`getUpdates`）接收按钮，**不需要公网端口**。

## 1. 建 bot、拿 token 和 chat id
1. 在 Telegram 里找 `@BotFather`，发 `/newbot`，按提示起名，拿到 token（形如 `123456:ABC-...`）。
2. 打开你的新 bot，点 Start，随便发一句话。
3. 浏览器访问 `https://api.telegram.org/bot<token>/getUpdates`，在返回的 JSON 里找 `"chat":{"id":...}`，这个数字就是 chat id（私聊是正数）。不要把含 token 的链接发给别人。
4. 写进 `.env`（已 gitignore，不要提交、不要贴到聊天或日志里）：
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
5. 测试：`pnpm telegram:test`，收到一条"✅ Job Radar"就对了。
6. Telegram **默认关闭**。在 `data/config/notify.yaml` 里把 `telegram.enabled` 改成 `true`（或在设置向导里打开）；runner 热加载，不用重启（第一次配好 `.env` 后需要重启 runner 一次）。

只有这个 chat id 里的消息和按钮会被处理，其他人发给 bot 的东西一律忽略（只在 debug 日志里记一行，不含内容）。

**群聊**：`TELEGRAM_CHAT_ID` 是群或频道（负数）时，群里每个成员都能按按钮、改你的投递状态。想限制成只有你自己，把你的 Telegram 用户 id（一个数字，`@userinfobot` 可以告诉你）写进 `.env`，多人用逗号分隔，然后重启 runner：
```
TELEGRAM_ALLOWED_USER_IDS=123456789
```
其他用户的按钮会被忽略（他们只会看到一句简短的“不允许”）。不设置时聊天里的所有人都会被响应，私聊没问题。chat id 是负数而这个变量没设时，doctor（`telegram.allowed_users`）会警告。

## 2. 推什么

所有消息、按钮、按钮回应和告警都用 Telegram 语言：`language.yaml` 的 `notify.locale`，为 `null` 时用默认界面语言（见
[languages.zh.md](languages.zh.md)）。岗位的一句话摘要优先用这种语言，其次 AI 输出语言，再次英文。
| 内容 | 规则 |
|---|---|
| 汇总（每轮一条） | 轮次类型和时间、新岗位数 / 通过过滤数 / 合格数、失败的来源 |
| 岗位消息 | 排序值 ≥ `push_min_score`（带高价值信号 ≥ `push_min_score_high_value`；哪些信号类别算高价值在 `/interests` 设置）；关注公司的新岗位不受门槛限制（没有分数也推）；被硬过滤掉的不推；还没打分的不推（关注公司除外）；每轮最多 `max_per_cycle` 条，超出的不再推，在看板里看 |
| 徽章 | 岗位有的每个信号类别一个，按 `/interests` 的顺序：图标加 Telegram 语言（`language.yaml: notify.locale`）的类别名称（没有这种语言的名称时用另一种），如 📈 股权；金额类显示统一换算的年薪区间（💰 €85–105k）· 👀 关注公司 · 需德语 B2；标签类和已删除的类别不做徽章 |
| 告警 | 通道熔断、登录态失效 / LinkedIn 验证页、预算 80% / 100%、AI provider 全部失败、一轮没跑完；同一类（类型 + 对象）`alerts.dedupe_hours`（24）小时内只发一次 |
| 其他功能排队的告警 | 别的功能（如备份）往 `notifications` 里写 `alert.<类型>` 的未发送行，下一轮 notify 会发出去并回填消息 id；同样按 类型 + `key` 24 小时去重（重复的直接标记为已处理，不发） |
| 申请提醒 | 每天一条（`reminders.send_at`，默认 09:00，按 `schedule.yaml` 的时区）："感兴趣"超过 `interested_days` 天还没申请、"已申请"超过 `applied_days` 天没回音；当天没有就不发 |

静默时段（`quiet_hours`，默认 22:00–07:00，按 `schedule.yaml` 的 timezone）：汇总和岗位消息等静默结束后的第一轮再推（岗位首次出现后、或拿到分数后 `candidate_window_hours`（48）小时内都还是候选：用"立即打分"或积压打分晚拿到分的旧岗位，达到门槛也会在下一轮推送）；告警默认不受影响（`alerts_exempt`）；申请提醒落在静默时段里就等到静默结束。

## 3. 按钮
| 按钮 | 申请状态 | 备注 |
|---|---|---|
| 👍 感兴趣 | `interested` | 只从"新 / 已归档"改；已经往后走的状态不会被覆盖 |
| 🚫 忽略 | `archived` | 只从"新 / 感兴趣 / 准备中"改 |
| 📄 定制简历 | `preparing` | 导出 JD 给 resume-kit（同一个导出函数，并把 `/tailor` 命令发回来，见 [resume-kit 联动](resume-kit.zh.md)） |
| ⭐ 收藏 / ☆ 取消收藏（第二行） | 不改申请状态 | 只写 / 删收藏（和网页 `/favorites` 是同一份数据）；消息末尾加 / 去掉一行"⭐ 已收藏"，**按钮保留**，第二行在「⭐ 收藏」和「☆ 取消收藏」之间切换，重复点是安全的；Telegram 里取消收藏没有撤销，想要回来再点一次 ⭐ 收藏（网页上写的备注会丢） |

点状态按钮（👍 🚫 📄）以后消息被编辑成"已标记"，按钮消失（岗位已收藏的话，标记下面还有一行"⭐ 已收藏"）；⭐ 收藏按钮不会让按钮消失。重复点同一个按钮是安全的（不会重复记时间线）。这次改版之前发出的消息，按钮照常可用。

## 4. 排错
- `pnpm telegram:test` 报 `chat not found`：chat id 不对，或者你还没在 bot 里点 Start。
- 收不到按钮回调：同一个 bot 只能有一个 `getUpdates` 消费者；别的程序在用同一个 token（或设置了 webhook）会得到 409，runner 日志里会看到 `getUpdates failed` 并自动退避重试。
- 日志和错误信息里不会出现 token（出现 `[token]` 占位）。
