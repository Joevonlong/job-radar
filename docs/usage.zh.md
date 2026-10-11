# 日常使用手册

第一次用先走设置向导（`/setup`，见 [setup.zh.md](setup.zh.md)）；向导之后想调整内容，看调优指南 [`getting-started.zh.html`](getting-started.zh.html)。

部署好以后，平时怎么用 Job Radar：怎么启动和打开、怎么知道它是否健康、在哪里看岗位和 JD。第一次部署、升级和回滚见 [`deploy.zh.md`](deploy.zh.md)，宿主机本身的设置见 [`host-setup.zh.md`](host-setup.zh.md)。

命令默认在项目目录（含 `package.json`、`compose.yaml`、`config/`、`data/` 的那个目录）下执行。

## 1. 启动和访问

### 它平时自己在跑

整套系统是 4 个 Docker 容器（`db` 数据库、`web` 网页、`runner` 定时采集、`jobspy` 抓取辅助），外加宿主机上的 `ai-worker`（macOS 上由 launchd 托管，Linux 上是 systemd 用户单元）（负责 AI 打分、翻译和 Telegram 推送）。它们都设置了自动重启：Docker Desktop 开机自启，容器就会自己回来，**平时不需要手动启动**。

处理轮按 `data/config/schedule.yaml` 自动运行（按其中的 `timezone`）：

| 轮次 | 时间 |
|---|---|
| 早轮 | 工作日 07:00 |
| 晚轮 | 工作日 17:00 |
| 周末轮 | 周六、周日 09:00 |

宿主机关机或睡眠错过了轮次，runner 启动时会补跑一次（`catch_up`）。

### 手动启动和停止

| 要做的事 | 命令 |
|---|---|
| 启动（或代码改动后重建） | `pnpm stack:up`（= `docker compose up -d --build`） |
| 停止（数据保留） | `pnpm stack:down` |
| 只重启某个服务 | `docker compose restart runner`（或 `web` 等） |
| 看四个容器的状态 | `docker compose ps` |
| 正式升级到最新版本 | 运行 `scripts/ops/deploy.sh`（见 `deploy.zh.md`） |
| ai-worker 没在跑 | 运行 `scripts/ops/install-ai-worker.sh` |

永远不要运行 `docker compose down -v`：`-v` 会删除数据库卷。

### 打开网页

| 在哪里 | 地址 |
|---|---|
| 这台机器上 | http://127.0.0.1:3000 |
| 手机 / 其他设备（同一个 Tailscale 账号） | `data/config/notify.yaml` 里的 `public_base_url`（`https://<机器名>.<tailnet>.ts.net`） |

网页只在本机和 tailnet 里能打开，不在公网上。如果设了网页口令（见 [configuration.zh.md](configuration.zh.md#网页访问可选口令监听地址和端口)），其他设备会先出现一次登录页；会话保持 30 天，“退出登录”在侧栏底部（手机上在 ☰ 菜单里）。本机上的浏览器不需要口令。手机上先打开 Tailscale App 并连接，再打开这个地址。Telegram 消息里的链接也指向这个地址。

## 2. 监控：怎么知道它健康

### 一条命令全面体检：`pnpm run doctor`

```bash
pnpm run doctor
```

逐项检查容器、数据库、runner 和 ai-worker 心跳、claude / codex 登录、Telegram、Tailscale、备份、磁盘、各通道的 key 和预算、上一轮和下一轮、AI 积压，大约 40 项，每项是 ✅ / ⚠️ / ❌，⚠️ 和 ❌ 下面有「怎么办」。最后一行是汇总：

```
合计：39 ✅  3 ⚠️   0 ❌  —  有需要留意的地方（退出码 1）
```

- 全是 ✅（退出码 0）：一切正常。
- 有 ⚠️（退出码 1）：能运行，但有要留意的地方，比如某个通道缺 key、磁盘空间偏低。
- 有 ❌（退出码 2）：有东西坏了，按「怎么办」处理。

一定要写 `pnpm run doctor`，`pnpm run doctor` 是 pnpm 自带的另一个命令。doctor 是只读的：不发消息、不调用 AI、不花钱。每一项的含义见 `deploy.zh.md` 第 3 节。

### 网页上看：`/sources` 来源页

打开 http://127.0.0.1:3000/sources：每个通道一张紧凑卡片（指示灯、名称、本轮抓取的大数字、趋势、最近几轮的健康方块和一行状态；只有一轮记录时趋势写「1 轮」，从没跑过的通道写「无记录」）。点卡片底部的「详情」展开：立即采集 / 测试按钮、本月用量和预算、最近 10 次运行的条数和错误，LinkedIn 级联最近由哪个通道服务，AI 本月用量，runner 心跳，AI worker 卡片（心跳、队列、画像不完整时的提示）。今日页 `/` 顶部也有本轮各来源的条数和失败数。

### 不用看也会知道：Telegram 告警

出问题时 runner 会主动发 Telegram：通道熔断、LinkedIn 登录态失效或遇到验证页、预算到 80% / 100%、AI provider 全部失败、一轮没跑完、ai-worker 掉线、备份失败。同一类告警 24 小时内只发一次。每轮结束还有一条汇总消息（新岗位数、通过过滤数、合格数、失败的来源），**收到汇总就说明那一轮跑完了**。

### 只看一眼的快速检查

```bash
curl -s 127.0.0.1:3000/api/health          # 网页和数据库：{"status":"ok",...}
docker compose ps                          # 四个服务都应是 Up (healthy)
```

### 看日志

```bash
docker compose logs -f --tail 100 runner              # 采集、处理轮、推送排队
docker compose logs --tail 100 web                    # 网页
tail -f data/logs/ai-worker.out.log    # ai-worker：打分、翻译、推送
tail -f data/logs/ai-worker.err.log    # ai-worker 的错误
```

## 3. 看岗位：网页看板

主要入口是网页。各页面：

| 页面 | 用来 |
|---|---|
| `/` 今日 | 本轮和今天的新岗位，按排序值排；顶部是各来源的条数；可以切换保存的视图 |
| `/favorites` 收藏 | 你用 ⭐ 收藏的所有岗位（含已关闭、被硬过滤、已忽略的，行里照常标出），默认按收藏时间排，也可以按排序值；每行可以写一句备注（最多 200 字，Enter 或离开输入框保存，Esc 取消）；取消收藏的提示上有「撤销」（备注和收藏时间一起恢复）。收藏和申请状态互不影响：一个岗位可以既是「已申请」又被收藏，收藏也不进看板、不触发"感兴趣超过 N 天"提醒。侧栏的数字是收藏总数 |
| `/jobs` 全部岗位 | 点"排序值""年薪""新鲜度"列头排序（再点切换升降序，见"列表排序"）；全文搜索 + 筛选（分数、薪资、高薪信号、来源、城市、办公方式、岗位状态、德语要求、合同、申请状态、日期；来源、城市、办公方式、合同、岗位状态、申请状态**可以多选**）；默认隐藏被硬过滤掉的岗位，可以切换显示（"只看被过滤的"即 `filteredOnly=true`，只列出它们：/insights 上被过滤的数字打开的就是它；不存进视图）；当前筛选可以保存成视图（「仅收藏」只看收藏的岗位，地址里是 `fav=true`，**不会**存进视图；「只看未看」是 `unseen=true`，同样不存进视图）；未看的岗位加粗带圆点，计数旁有「N 条未看 · 全部标为已看」（见"已看与未看"）；显示为已关闭的岗位默认隐藏（选了岗位状态筛选时除外），计数旁的「已关闭（N）」列出它们（见"已关闭的岗位"） |
| `/jobs/<id>` 岗位详情 | **JD 原文和译文（译成你设置的语言）**、AI 匹配理由和差距、薪酬与福利信号、德语要求、所有来源链接和"查看原帖"、"标为已申请"、申请状态、备注、"定制简历"；"标记为已关闭"（可写一句备注）/"重新打开"，已关闭的岗位会写明原因和原帖最近一次检查的时间 |
| `/pipeline` 申请看板 | 新 / 感兴趣 / 准备中 / 已申请 / 面试中 / Offer / 已结束；每列顶部的条是这一列占流程的比例；"流程中"只有一个定义：没有结束的申请（含「新」列），页面标题的"N 个岗位在流程中"、各列占比和侧栏"申请 N"数的是同一批；卡片上的进度条是在当前状态待了几天（阈值来自 `notify.yaml` 的 `reminders`，超过阈值的部分变红；读屏的刻度就是阈值本身，超出的天数写在读数里）；七列等宽，放不下时看板在自己的容器里横向滚动；「新」列显示有申请记录但还没决定的岗位（只写了备注、挂了简历，或被设回「新」的）；拖拽或用卡片右上角的「⋯ 移动到…」菜单改状态，改完的提示上有「撤销」（撤销会把这一步从时间线里去掉并恢复原来的计时，不会多记两条）；「已结束」列先显示被拒 / 我放弃 / 已忽略的数量，点开看卡片；键盘用户：Tab 到卡片上的拖动按钮，空格或回车拿起，方向键换列，空格或回车放下，Esc 取消（读屏会播报当前所在的列），也可以用「⋯ 移动到…」菜单 |
| `/sources/ai-usage` AI 用量 | 每次 AI 调用的模型、token、耗时、折合 API 费用和实际开支；时间范围、筛选、按天图、三张明细表、调用明细、导出 CSV（见 `ai-usage.zh.md`） |
| `/insights` 统计 | 每日新增、来源分布、城市、薪资披露率、信号分布、申请漏斗（7 / 30 / 90 天） |
| `/sources` 来源 | 见上一节 |
| `/me` 我的画像 | 编辑 `me.yaml` / `preferences.yaml`（简介和技能决定 AI 打分） |
| `/interests` 感兴趣清单 | 信号词、关注公司、AI 每周学习建议的批准 / 拒绝 |
| `/settings` 设置 | 所有配置的表单编辑；"手动操作"标签里有"立即跑一轮"、"重打过期分数" |

### 怎么看 JD

1. 打开 `/`（今天的）或 `/jobs`（全部的），点岗位标题进入详情页。
2. 详情页的 JD 区块是原文，可以切换到译文；还没翻译的点"翻译"，ai-worker 几十秒内完成（页面显示进度）。
3. 想投：点"查看原帖"打开原链接（公司 ATS 来源打开岗位页而不是申请表单，没有岗位页链接时才退回申请链接；聚合源用它挑好的雇主直链；只是打开，**不会**自动变成已申请）；确认投递之后再点"标为已申请"（有撤销）；或者点"定制简历"导出 JD 并拿到 resume-kit 命令（见 `resume-kit.zh.md`）。

快捷键：`⌘K`（Windows / Linux 上是 `Ctrl K`）搜岗位，列表里 `j` / `k` 上下移动，`s` 标为感兴趣（👍），`x` 忽略，`f` 收藏 / 取消收藏（★），`u` 把当前行在已看 / 未看之间切换，`c` 标记为已关闭（或重新打开）。详情页的「收藏」按钮（手机上是底栏里的星）同样可用。图标约定：★ / ⭐ 只表示收藏，👍 是"感兴趣"（申请流程里的一个状态），🏅 是 T3 "有竞争力"徽章（T1 到 T4 是四个薪酬信号类别：写明的金额、股权、定性的薪资措辞、奖金；见 [signals.zh.md](signals.zh.md)），📌 是视图的默认标记。

### 多选筛选

`/jobs` 的来源、城市、办公方式、合同、岗位状态可以各选多个值（申请状态本来就能多选）：

- 点开筛选框，勾选想要的项；城市和来源有搜索框（输入 `munc` 能找到 München）；底部有"已选 N 项 · 清除 · 完成"。键盘：Tab 到按钮，Enter / ↓ 打开，↑ ↓ 移动，Enter 勾选，Esc 关闭。
- 规则：**同一项里满足任一即可，不同项之间必须同时满足**。比如"城市 Berlin + München，办公方式 远程"= 在 Berlin 或 München 的远程岗位。选 München 会连带它的都市圈写法（Garching 等）。
- 搜索框下面一行标签列出每个已选值，点 × 只去掉这一个值；手机上不打开筛选面板也能看和删。"筛选 (n)"里一个多选筛选只算 1。
- 地址里是重复参数：`/jobs?city=Berlin&city=M%C3%BCnchen&workplace=remote`。旧的单值链接（`?city=Berlin`）照常可用，读成"只选了一个"。空值、不认识的值、重复值会被忽略。
- 保存成视图时，选一个值写成单个值（`city: München`，和以前的文件一样），选多个写成列表（`city: [Berlin, München]`）；手写 `interests.yaml` 两种写法都可以。`/interests` 的视图卡片显示"城市：Berlin或München"；今日页切到这个视图按多个值筛，标签上的数字一致。今日页的视图标签本身仍是单选（视图是互斥的预设）。
- 回退提醒：如果回退到支持多选筛选之前的版本，旧代码不认列表写法；回退前先把多值视图改成单个值或删掉，再跑 `pnpm config:check`。

### 列表排序

`/jobs` 宽屏列表的列头 **排序值**、**年薪**、**新鲜度** 可以点击排序（其他列不排序）：

- 点一个列头按它排序，高的 / 新的在前；再点同一个列头切换升降序。列头旁的箭头标出当前排序列和方向，其他可排序的列头显示淡色的双向箭头。键盘：Tab 到列头，回车。
- **年薪** 按市场基准货币的可比年薪排序（写明区间取中点，否则取写明的那一端；和详情页的中位数同一口径）。标为"可能是外地薪资"的排在所有可比年薪之后；没有可用薪资的岗位（未披露、待核对、还没按当前基准货币换算）不论升序降序都排在最后。按排序值排序时，没打分和被硬过滤的岗位也始终在最后。
- 手机上（以及窄窗口）没有列头：用筛选里的 **排序** 下拉（也有"年薪"和"发布时间"），旁边的箭头按钮切换升降序。列头、下拉和按钮改的是同一个设置，任何宽度下顺序一致。
- 地址会记住排序：`/jobs?sort=salary&dir=asc`（默认的降序不写 `dir`）。旧链接如 `?sort=rank` 照常可用。保存的视图不存排序。今日页和收藏夹保持各自固定的顺序。

### 已看与未看

每个岗位都记得你看过没有，点开几条再返回列表就能分清：

- **未看**的行标题加粗，前面有一个小圆点；**已看**的行标题是正常字重。今日、`/jobs`、收藏夹三处一致（屏幕阅读器会读出"未看：……"）。
- 岗位在这些时候记为**已看**：详情页真正在浏览器里显示出来（只是悬停链接或页面被预取不算）；点「查看原帖」（包括手机底栏的按钮和"来源"面板里的链接）；在列表行上做了操作（★、👍、✕ 或标记关闭）。只保留第一次的时间。
- **只看未看**（`/jobs` 上「仅收藏」旁边）只列出未看的岗位，可以和其他筛选组合；它在地址里（`unseen=true`），不存进保存的视图。
- 结果计数旁的 **N 条未看 · 全部标为已看**：在 `/jobs` 作用于当前筛选下的**全部页**，在今日页作用于当前视图的列表。之后的 toast 带「撤销」，只撤回这一批（之前已看的保持已看）。
- 想让岗位重新变成未看：详情页「⋯」菜单里的「标为未看」，或在列表行上按 `u`（再按一次改回已看）。
- **上次访问后新增**：系统仍然记得你上次打开今日或 `/jobs` 的时间（一次访问是一个会话：间隔不到 30 分钟的打开算同一次）。`/jobs` 按新鲜度从新到旧排序时，在最后一条新岗位下面有一条分隔线"以上为上次访问后新增 · N 条"（只出现在分界所在的那一页）；其他排序下，计数旁显示"上次访问后新增 N 条 · 按新到旧查看"，点链接切到这种排序；今日页只显示这句话。
- 升级后：上次访问之前首次发现的岗位，以及所有申请过或收藏过的岗位，一开始就是已看；之后的新岗位是未看。如果从没记录过访问，全部记为已看。

### 已关闭的岗位

岗位关闭有两种来路：系统发现，或者你告诉它。

- **你来标记**：详情页的"标记为已关闭"（可写一句备注，最多 200 字，之后显示在页面上）、列表行的第 4 个按钮（⊘），或在行上按 `c`。提示里有"撤销"，恢复成操作前的样子。标记关闭同时记为已看。"重新打开"（同一个按钮 / 按键）让它回来。你的判断一直有效，直到你改它；即使来源又列出了这个岗位也不变（详情页会提示"来源在某日仍列出此岗位"，方便你重新打开）。
- **系统发现**：连续 `possibly_closed_after_days`（7）天没有任何来源返回的岗位标为**可能已关闭**（黄色标签），并检查它的链接，404 / 410 就关闭。你**收藏**的、或申请状态为**感兴趣 / 准备中 / 已申请 / 面试中 / Offer** 的岗位，另外每 72 小时复查一次原帖页面（每轮最多 10 个）：404 / 410 →**来源已下架**；页面可见文字里出现"no longer accepting applications"、"Stelle ist bereits besetzt"这类句子 →**来源写明不再接收**，这只把岗位标为可能已关闭，并保存命中的句子和一小段原文作为证据（鼠标悬停标签可见，详情页标题下也会写出，并带被检查页面的链接）。你可以点"确认已关闭"，或者点"仍在招"（这个判断会保留，之后的检查不再把它藏起来）。
- **已关闭的岗位去哪了**：今日页和 `/jobs` 在没有选岗位状态筛选时隐藏显示为已关闭的岗位；可能已关闭的仍留在列表里，带黄色标签。`/jobs` 结果计数旁的**已关闭（N）**就是岗位状态筛选"已关闭 + 可能已关闭"（地址里是 `?status=closed&status=possibly_closed`，可以像其他筛选一样存进视图）。收藏夹照旧列出全部岗位，带标签。你关闭的岗位不再打分，也不推送到 Telegram。
- **复查怎么做**：每个岗位读一个页面，像一个守规矩的读者：自己的 User-Agent（`JobRadar/2 …`）、遵守 robots.txt（被禁止的页面不请求，记为"未查"）、同一网站每 3 秒最多一次请求、最多读 1 MiB、只搜可见文字（脚本、隐藏元素、导航、"其他岗位"这类侧栏和页脚都不算；最多前 200,000 个字符）。只请求公网地址：指向本机、Docker 网络或局域网的链接或跳转不跟随，跳转最多 5 次，跳到别的网站前先看那个网站的 robots.txt。页面正常打开时，可能已关闭的岗位重新变为在招。要登录或被 robots.txt 禁止的页面（比如 LinkedIn）查不到，请手动标记。短语来自市场包（`rules.yaml` 的 `closed_posting.phrases`，见 `market-packs.zh.md`）；可以在 `ui.yaml` 的 `job_checks.closed_recheck.extra_phrases` 里加自己的，或用 `enabled: false` 关掉复查。频率和大小在 `pipeline.yaml` 的 `lifecycle.watch_recheck`（见 `configuration.zh.md`）。
- 回退：旧版本会忽略你的关闭 / 仍在招判断和保存的证据，但不认识 `ui.yaml` 里的 `job_checks` 段：回退前先删掉它。

### 分数为什么是空的

排序值来自 AI 打分。岗位刚抓到时还没打分，按发布时间排在后面。打分在每轮结束后由 ai-worker 完成。如果一直没有分数：

- `pnpm run doctor` 看「画像够 AI 打分用」和「AI 没有积压」两项；
- `/me` 至少要填简介或技能，否则打分会暂停（今日页顶部会有横幅）；
- 详情页可以点"立即打分"单独打一个。

### 手机上：Telegram

每轮结束后，合格的新岗位（排序值 ≥ 70，带高价值信号的 ≥ 60（默认是达到薪资底线的写明金额或股权）；关注公司的不受门槛限制）逐条推到 Telegram，每条有 👍 感兴趣 / 🚫 忽略 / 📄 定制简历 三个按钮（点了直接写进申请记录）和一个 ⭐ 收藏 按钮（只加星标，不改申请状态，按钮保留，再点取消）。每轮最多推 10 条，其余在网页看。22:00–07:00 静默。规则见 `telegram.zh.md`。

## 4. 命令行

### 立即跑一轮（不等定时）

```bash
pnpm cycle:run                                  # 跑一轮完整的采集 → 处理 → AI → 推送
pnpm cycle:run --channel arbeitsagentur         # 只跑一个通道
```

也可以在 `/settings` 的"手动操作"标签点"立即跑一轮"，效果一样。

### 在终端里看岗位和 JD

日常还是网页最方便；想在终端里快速看，可以直接查数据库（只读）。下面的命令会用容器里的数据库账号，不需要你输入密码。

今天排名最前的 20 个岗位（通过了硬过滤的）：

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select j.id, s.rank_value::int as rank, left(j.title, 50) as title, left(c.name, 24) as company,
       j.workplace, to_char(j.first_seen_at at time zone 'UTC', 'MM-DD HH24:MI') as seen
from jobs j
join companies c on c.id = j.company_id
left join lateral (select * from scores where job_id = j.id order by created_at desc, id desc limit 1) s on true
where j.status = 'active' and s.filter_result = 'passed'
order by s.rank_value desc nulls last, j.first_seen_at desc
limit 20;
SQL
```

看某一个岗位的完整 JD（把 `123` 换成上面的 id，或详情页地址 `/jobs/123` 里的数字）：

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -x -v id=123' <<'SQL'
select j.id, j.title, c.name as company, j.locations_json, j.workplace, j.contract,
       j.german_level_required, j.salary_json, j.description
from jobs j join companies c on c.id = j.company_id
where j.id = :id;
SQL
```

按关键词搜标题和描述（把 `kubernetes` 换成你的词）：

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v q=kubernetes' <<'SQL'
select j.id, left(j.title, 60) as title, left(c.name, 24) as company
from jobs j join companies c on c.id = j.company_id
where j.search_tsv @@ plainto_tsquery('simple', :'q')
order by j.first_seen_at desc limit 20;
SQL
```

想把一个 JD 存成文件：详情页点"定制简历"会导出到 `data/exports/jd/<公司>-<职位>-<日期>.md`（带 front matter），也可以在 Telegram 点 📄。

### 其他常用命令

| 命令 | 用途 |
|---|---|
| `pnpm run doctor` | 全面体检 |
| `pnpm config:check` | 改完 `data/config/*.yaml` 或画像后检查格式（含 `ai.yaml` ↔ `models.yaml` 的跨文件检查） |
| `pnpm ai:probe --provider <服务商> --model <模型 id>` | 新模型加进 `data/config/models.yaml` 后，先用它发一次极小请求再去设置页选（`--model` 必须配且只配一个 `--provider`；不带 `--model` 时看各 provider 此刻是否可用） |
| `pnpm sources:list` | 列出所有采集来源和健康状态（`--status failing`、`--json`、`--strict`），见 `sources.zh.md` |
| `pnpm telegram:test` | 发一条测试消息，确认 Telegram 通 |
| `pnpm reprocess` | 规则改了以后，按新规则重新解析已入库的岗位 |
| `pnpm db:studio` | 打开 Drizzle Studio，在浏览器里翻数据库表 |
| `scripts/ops/backup.sh` / `scripts/ops/restore.sh` | 手动备份和恢复（见 `backup-restore.zh.md`） |

## 5. 每天的使用习惯（建议）

1. 早上 07:00 以后看 Telegram 的汇总和推送，对要跟进的点 👍，想先存着的点 ⭐ 收藏（之后在 `/favorites` 看）。
2. 有空时打开 `/`，过一遍今天的新岗位；值得投的进详情页看 JD 和匹配理由。
3. 投递后在详情页或 `/pipeline` 改状态，系统会按天数提醒你跟进。
4. 一周跑一次 `pnpm run doctor`，或者收到告警时再看。
