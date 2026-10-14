# Telegram 推送

每轮处理完，宿主机上的 `ai-worker` 把合格的新岗位推到你的 Telegram（runner 只负责接收按钮回调，所以收不到消息时请先确认 ai-worker 在运行）；消息下面有 👍 感兴趣 / 🚫 忽略 / 📄 定制简历 三个按钮，点了就写进申请记录（和看板是同一份数据）；第二行还有一个 ⭐ 收藏，只加星标。runner 用 long-polling（`getUpdates`）接收按钮，**不需要公网端口**。

## 1. 用一条命令配置

1. 在 Telegram 里找 `@BotFather`，发 `/newbot`，按提示起名，复制它给你的 token（形如 `123456:ABC-...`）。
2. 在运行 Job Radar 的电脑上、项目目录里运行：
   ```bash
   pnpm run setup --step telegram
   ```
3. 按提示粘贴 token（输入时不显示）。命令会向 Telegram 核对它，并显示 bot 的名字。
4. 给你的 bot 随便发一句话（群聊的话，把 bot 拉进群，在群里发一句）。命令会找到这个聊天、显示名字并请你确认；如果在规定时间内（`notify.yaml` 的 `telegram.setup.wait_for_message_seconds`，180 秒）没等到消息，可以自己输入 chat id。默认只采用提示之后发来的消息：之前就在等待的消息（可能是旧的，也可能是别人发的）只在没有新消息时才会提出来，会明确标出，并且只有你回答“是”才会采用。
5. 群聊时它会问谁可以按按钮，默认是刚才发消息的人（你）；见下面的“群聊”。
6. 它发一条测试消息并问你有没有收到，再显示一份摘要（chat id 打码，token 从不显示），你确认后才写入 `.env`。
7. 它会问要不要打开推送（`notify.yaml` 的 `telegram.enabled`），然后重启服务让它们读到新值，并检查结果（见下文）。

完整的 `pnpm run setup` 问答也会走到这一步。网页的“设置 → 通知”和设置向导会显示 bot 是否已配置（只显示哪些变量已设置，从不显示值）、最近一次测试消息和同一条命令；网页本身从不读取或修改 token。

### 它写了什么

- `.env` 里只改 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 和 `TELEGRAM_ALLOWED_USER_IDS`，其他行保持原样。
- 改 `.env` 之前先在旁边存一份备份（`.env.backup-<时间>`，只有你能读，已 gitignore）；新文件一次性写入，权限 600。还没有 `.env` 时，从 `.env.example` 开始。`.env` 是符号链接时，改的是它指向的文件，链接本身保留。
- 改动的那一行保留 `export ` 前缀和行尾的 ` # 注释`。
- **备份里仍是之前的值，包括旧的 token。** 更换或移除 bot 后，确认一切正常就删掉它（`rm .env.backup-<时间>`，命令会打印确切的文件名）。否则旧 token 会一直留在磁盘上。
- token 不会出现在屏幕、日志或 `pnpm run setup --answers` 的答案文件里。

### 已经配置过时

再次运行命令会显示当前的 bot 和打码的 chat id，并问你要做什么：**保留**、**更换**（新 token 或新聊天）、只发一条**测试**消息，或**移除**（清空这三个变量、关闭推送并重启）。

### 重启服务

web 和 runner 只在容器创建时读取 `.env`，宿主机上的 ai-worker 在启动时读取。所以写完 `.env` 后命令会：

- 重建正在运行的 `web` 和 `runner` 容器（`docker compose up -d --no-deps --force-recreate --wait`，compose 项目名取 `COMPOSE_PROJECT_NAME`，否则取 `schedule.yaml` 的 `doctor.compose_project`）；
- ai-worker 已安装并在运行时重启它（macOS 用 `launchctl kickstart -k`，Linux 用 `systemctl --user restart`）；
- 在 `telegram.setup.poller_check_seconds` 秒内等 runner 日志出现 `telegram poller started`，再运行 `pnpm run doctor --only telegram` 并显示结果。

如果重启失败，或者你加了 `--no-restart`，它会改为打印需要你自己运行的命令，例如：
```bash
docker compose -p job-radar up -d --no-deps --force-recreate web runner
launchctl kickstart -k gui/$(id -u)/<ai-worker 标签>        # macOS
systemctl --user restart job-radar-ai-worker.service          # Linux
```

**一个 bot 只能有一个读取者。** runner 轮询 bot 来接收按钮，而 Telegram 每个 token 只允许一个轮询者。如果你用 runner 正在用的 token 重新配置，命令会在等你发消息期间停掉 runner，之后再启动它（按 Ctrl-C 取消时也会）。这期间按下的按钮不会丢：命令只取消息，按钮留在队列里等 runner 处理。如果有别的程序在轮询同一个 bot，Telegram 会回“冲突”：这时自己输入 chat id。

按 Ctrl-C 会取消命令，命令随后把服务恢复原状。Docker 和 ai-worker 的命令在单独的进程组里运行，所以 Ctrl-C 不会把重建打断在半路；服务恢复期间再按 Ctrl-C 只会显示一句提示。如果重建失败、web 或 runner 停在那里，命令会把它们重新启动，并打印需要你手动收尾的命令。

### 手动配置

1. 给 bot 发一句话，在浏览器里打开 `https://api.telegram.org/bot<token>/getUpdates`，找到 `"chat":{"id":...}`：这个数字就是 chat id（私聊是正数）。不要把含 token 的链接发给别人。
2. 写进 `.env`（已 gitignore，不要提交、不要贴到聊天或日志里）：
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
3. 用上面的命令重建容器并重启 ai-worker。
4. 测试：`pnpm telegram:test`，收到一条"✅ Job Radar"就对了。
5. Telegram **默认关闭**。在 `data/config/notify.yaml` 里把 `telegram.enabled` 改成 `true`（或在设置向导里打开）；runner 会热加载这个开关，不用重启。

只有这个 chat id 里的消息和按钮会被处理，其他人发给 bot 的东西一律忽略（日志级别为 `debug` 时记一行，不含内容；见 [configuration.zh.md](configuration.zh.md) 的“日志级别”）。

**群聊**：`TELEGRAM_CHAT_ID` 是群或频道（负数）时，群里每个成员都能按按钮、改你的投递状态。想限制成只有你自己，把你的 Telegram 用户 id（一个数字，`@userinfobot` 可以告诉你，配置命令也会给出发消息那个人的 id）写进 `.env`，多人用逗号分隔，然后重启 runner：
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
| 告警 | 通道熔断、登录态失效 / LinkedIn 验证页、预算 80% / 100%、AI provider 全部失败、一轮没跑完；同一类（类型 + 对象）`alerts.dedupe_hours`（24）小时内只发一次。Job Radar 的 AI 用量上限（[ai-providers.zh.md](ai-providers.zh.md)）：订阅 CLI 窗口满或报告限制时发一条，恢复可用时发一条；只在状态变化时发，`quota_guard.alert_dedupe_hours`（6）防状态来回抖动 |
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
- `.env` 里有值，但“设置 → 通知”仍显示“未连接”：`.env` 改了之后 web 容器没有重建（普通的 `docker compose restart` 仍用旧值）：用上面的命令重建。
- 收不到按钮回调：同一个 bot 只能有一个 `getUpdates` 消费者；别的程序在用同一个 token（或设置了 webhook）会得到 409，runner 日志里会看到 `getUpdates failed` 并自动退避重试。
- 日志和错误信息里不会出现 token（出现 `[token]` 占位）。
