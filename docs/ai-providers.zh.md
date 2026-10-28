# AI provider 与宿主机 AI worker

AI 可以走订阅命令行（`claude`、`codex`）、按量计费的 API key，或两者都用，由你选。无论用哪种，每次 AI 调用都由宿主机上的 `ai-worker` 执行，订阅登录和 API key 都不会放进容器。每个提供方会收到什么，见 [privacy.zh.md](privacy.zh.md)。

## 订阅还是 API key

| | 怎么用 | 花费 |
|---|---|---|
| **订阅命令行**（默认） | ai-worker 用你已有的登录运行 `codex` 和 `claude`（`codex login`；运行 `claude` 后 `/login`）。 | 不按 token 计费。每天的调用上限（codex 200 次、claude 100 次）保护你的订阅额度。 |
| **API key**（可选） | 在 `.env` 里填 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 或 `MIMO_API_KEY`；DeepSeek 和 MiMo 还要在 `ai.yaml` 里打开。 | 按 token 计费，到 `ai.yaml` 里 `monthly_api_budget_usd` 的月预算就停。 |

用一种或两种都行；API 排在命令行之后才会用到。`pnpm ai:probe` 显示现在哪些可用。消费者订阅是个人许可：要给你自己以外的人用之前，
先看 [commercial-use.zh.md](commercial-use.zh.md)。用量和费用见 [ai-usage.zh.md](ai-usage.zh.md)。

## 谁在哪里跑什么

| 进程 | 位置 | 做什么 |
|---|---|---|
| runner | Docker 容器 | collect → pipeline → filter → signals（规则）→ maintenance；`ai` 和 `notify` 步骤不执行，只写一个 `run_ai` 请求（`ai.yaml: execution: host`，默认） |
| web | Docker 容器 | 网页的"翻译"按钮写 `translate_job` 请求并轮询状态；"重新打分"写 `rescore_stale` 请求；本身不调用任何 AI |
| ai-worker | 宿主机（macOS 上是 launchd 服务，Linux 上是 systemd 用户单元；其他系统用任意进程管理器） | 处理 `run_ai`（score → signals → translate → breakdown（仅 `breakdown.yaml` 为 auto），然后 notify）、`translate_job`、`breakdown_job`（详情页"拆解这个岗位"）、`rescore_stale`；写自己的心跳（`runner_heartbeats.process = 'ai-worker'`） |

请求都在表 `control_requests` 里；runner 和 ai-worker 各自只领自己那几种（`src/lib/control/kinds.ts`），所以谁重启都不会把对方正在做的事标成失败。`run_ai` 要等它指向的那一轮结束后才会被领走（那一轮最后才写 cycle 摘要）。worker 做完把真实的 `ai` 和 `notify` 两段写回那一轮的摘要，替换容器里留下的 `delegated` 占位。

多轮已结束的周期排队时，worker 会逐轮处理 AI 工作，把岗位通知合并到最后一个可领取周期的摘要中；仍在运行的周期不会挡住这份摘要，告警仍会立即发送。
摘要发送失败后，请求保留为待处理，经过 `host_worker.poll_seconds` 后重试，已完成的 AI 工作不会重复执行。
重试保留原来的岗位候选窗口，即使很久以后才恢复发送或 worker 重启，也不会因窗口过期漏掉原来的候选岗位。
`--once` 在没有可领取请求时退出；等待重试时间的失败摘要仍留在队列中，由下次启动的 worker 继续处理。

**规则**：任何会调用 AI 的请求种类只由 ai-worker 领取。种类清单只有一份：`AI_CONTROL_REQUEST_KINDS`（`src/lib/db/repos/control-requests.ts`），真实 handler 在 `registerAiControlHandlers()`（`src/lib/control/ai-handlers.ts`）一处注册。新增一种（例如 `run_suggest`、`score_jobs`）：数据库枚举加值（迁移）→ 加进该清单 → 注册 handler；单元测试会在枚举里有未归类的种类时失败。

`ai.yaml: execution: container` 时一切照旧：runner 自己在容器里跑 AI 和推送，并领 `translate_job` / `rescore_stale`；这需要你自己把订阅令牌或 API key 放进容器（compose 里默认把这些变量置空，要用就写 `compose.override.yaml`），不推荐。

## 哪些 provider 会收到岗位文本

只有已开启的 provider（`providers.<id>.enabled`）才会被调用，每个 AI 任务按顺序依次尝试：先用 `ai.yaml` 里该任务自己的
`tasks.<task>.order`，没有就用全局 `order`（`api` 表示 `api_order`）。某个 provider 不可用时（没安装、已登出、触顶后冷却中、超过每日上限、
没有 key），下一个接手，所以**该任务列表里的每一个 provider 都可能收到这个任务的文本**：岗位描述，评分时还有提示词需要的画像字段。
设置 → AI → 路由按任务列出这份清单，数据来自已保存的 `ai.yaml`；首次设置向导的 AI 步骤在你开启 provider 之前也会说明。订阅 CLI（`claude`、`codex`）
通过你自己的账号把文本发给 Anthropic / OpenAI；API provider（Anthropic、DeepSeek、小米 MiMo）发给厂商的 API。联网搜索任务（`salary_lookup`）只使用能联网搜索的 provider。
具体哪些内容会离开你的电脑、厂商如何处理，见 [privacy.zh.md](privacy.zh.md)。不想让某个厂商收到文本，就关掉对应的 provider。

## 登录

见 [host-setup.zh.md](host-setup.zh.md) 第 6 节：`claude` → `/login`，`codex login`。provider 顺序、选哪个模型、超时在 `data/config/ai.yaml`，有哪些模型和单价在 `data/config/models.yaml`（模型目录）；`pnpm ai:probe` 看哪些 provider 此刻可用，也可以在 `/sources` 的"AI provider 健康度"里点某个 provider 的"测试"（由 ai-worker 发同样的极小请求，见 [settings.zh.md](settings.zh.md)）。pay-per-token 的 API provider（Anthropic / DeepSeek / MiMo）保留实现，但只有你在 `.env` 里填了 key 才会被路由选中，并受 `monthly_api_budget_usd` 限制。DeepSeek 和 MiMo 出厂是关的（`enabled: false`），要用哪个就把它改成 `enabled: true`；它们的 key 只发往厂商自己的主机（见 [ai-worker 不从 ai.yaml 接受的东西](#ai-worker-不从-aiyaml-接受的东西)）。key 由宿主机的 ai-worker 读取，runner 容器里这几个变量被显式置空。

## 配置

```yaml
execution: host          # host | container
host_worker:
  poll_seconds: 5            # 每隔多少秒看一次队列
  max_requests_per_poll: 10  # 每次最多处理几个请求
  heartbeat_seconds: 15
  offline_after_seconds: 180 # 超过这么久没有心跳：/sources 显示没有响应，runner 发 Telegram 告警
  disk_check_minutes: 10     # 宿主机磁盘剩余空间的测量间隔（量 Docker 的 DataFolder 所在的卷，见 [deploy.zh.md](deploy.zh.md) 的磁盘一节）
  # docker_data_path: /Volumes/<外置盘>/.docker-data   # 可选：直接指定 Docker 数据目录；不写则读 Docker 的设置文件，launchd 下可能被 macOS 隐私弹窗卡住（测量超时，/sources 低空间提示不更新）。pnpm run doctor 的 disk.docker_location 会打印该填的值
  log_max_mb: 10             # data/logs/ai-worker.*.log 超过这么多 MB 就轮转
  log_keep: 3                # 留几份旧日志（.1 最新）；0 = 只清空
translation:
  chunk_chars: 2500          # 长 JD 切成的片段长度
  chunk_timeout_seconds: 90  # 一个 provider 翻一片最多等多久
  glossary:                  # 固定译法：原文术语 -> 译文（写成一样 = 保留英文）；只发该片文本里出现的术语
    Solutions Engineer: Solutions Engineer
```

## 用量控制与冷却

像桌面客户端（选 provider、排 fallback 顺序、设用量上限）那样，用哪个订阅、先用谁、用多少都在 `data/config/ai.yaml` 里配置，也可以在设置页的 AI 标签里改：

- **顺序**：`order`，默认 `[codex-cli, claude-cli, api]`，codex 优先；claude 订阅和你自己交互使用共用，所以排在后面。每种任务可以用 `tasks.<任务>.order` 单独覆盖。
- **开关和每日上限**：每个 `providers.<名字>` 都有 `enabled`（false = 路由不会试它）和 `daily_request_cap`（每天最多多少次模型调用，失败的也算；0 = 不限）。默认 claude-cli 100 次/天、codex-cli 200 次/天，API provider 不限（仍受 `monthly_api_budget_usd` 约束）。API 层按 `api_order` 依次尝试，默认 `[anthropic, deepseek, mimo]`。"一天"按 `schedule.yaml` 的时区。
- **冷却**：provider 报额度 / 会话上限 / 限流（"hit your session limit"、"usage limit"、429 等）时，所有进程（runner、ai-worker）都会跳过它，直到错误信息里写的恢复时间；解析不出来就冷却 `cooldown.default_minutes`（默认 60 分钟），最长 `cooldown.max_minutes`。状态存在 `runtime_state`（键 `ai_provider:<名字>`），不需要迁移。恢复时间按 ai-worker 所在机器的本地时区理解。
- **用量上限（订阅 CLI）**：`quota_guard` 是 Job Radar 自己对 claude-cli、codex-cli 调用频率的限制。它**只统计 Job Radar 自己的调用**（`ai_usage`，失败的也算）；订阅和你自己在终端、网页里的使用共用，这部分它看不到，所以它只会比真实上限晚触发，不会提前（真实上限先到了，仍由上面的冷却接住）。每个 CLI（`quota_guard.providers.codex_cli` / `claude_cli`）有两项：`hard_requests` 是滚动窗口 `window_hours`（默认 5）内的调用数，达到后该 CLI 对所有任务暂停（包括你自己点的），等足够多的调用滑出窗口再继续（降到 `resume_ratio` × `hard_requests` 以下，默认 0.8）；`cycle_request_cap` 限制一轮处理的调用数，这一轮剩下的留到下一轮。**你主动发起的请求（立即打分、翻译、拆解、查薪资、测试）不受每轮上限约束**，只在窗口满时受限。被上限跳过时，任务**不会改走付费 API**（`fallthrough_to_api: false`，默认）；上面的错误冷却照旧可以落到 API。填 0 关闭该项；`enabled: false` 关闭整个上限（行为回到没有它之前）。窗口满或 provider 报告限制时 Telegram 发一条告警，恢复可用时再发一条（`notify_recovery`）；状态持续不会重发（`alert_dedupe_hours` 只防状态来回抖动）。每轮上限不发告警，推送摘要最后一行写明有几个新岗位等打分、预计什么时候处理。状态存在 `runtime_state`（键 `ai_quota:<名字>`），不需要迁移。默认值 = 维护者自己用量中见过的最大值 × 1.5（codex-cli 窗口 861 / 每轮 554，claude-cli 399 / 399）。各人的订阅档位不同，请在设置页（AI 标签的“限额”块）调整；`pnpm ai:usage-stats` 只读地打印你自己的最大值和建议上限。
- **每轮时间预算**：`cycle_budget_minutes`（默认 30）限制一轮里打分、信号占用的时间，超过就留到下一轮；这一轮没有新岗位时用 `idle_cycle_budget_minutes`（默认 10）。0 = 不限。所有 provider 都在冷却 / 关闭 / 到上限时，AI 步骤直接跳过（cycle 摘要里写明原因）。
- **任务 `breakdown`**：岗位拆解，默认沿用全局顺序（codex 优先，理由同翻译：输出长，订阅 CLI 没有 4096 输出上限）；可用 `tasks.breakdown.order` 单独排，codex 推理强度用 `reasoning_effort_by_task.breakdown`。默认关闭，见 [breakdown.zh.md](breakdown.zh.md)。
- **任务 `salary_lookup`**：按需查薪资（[salary.zh.md](salary.zh.md)），是**唯一**可以用工具（网页搜索）的 AI 调用。默认顺序 `[claude-cli, anthropic]`；只尝试能搜网页的 provider（DeepSeek、MiMo 跳过）；允许搜网页的任务清单写死在代码里（`src/lib/ai/web-tasks.ts`），任何设置都不能让别的任务上网。可以把 codex-cli 加进 `tasks.salary_lookup.order`，但它的网页搜索不能限定域名（设置页会提示）。
- **推送先于翻译**：ai-worker 先做打分和信号，然后立刻推送，最后才翻译（翻译标了 `late`，不影响推送内容）。
- **看状态**：`/sources` 的"AI provider 健康度"显示每个 provider 的状态（可用 / 未配置 / 已关闭 / 未登录 / 已达每日上限 / 已达 Job Radar 用量上限到几点 / 冷却到几点）、用量上限窗口内 Job Radar 自己的调用数对比 `hard_requests`、今日请求数对比上限、最近一次成功和失败；每行有"测试"按钮。设置页 AI 标签的顺序列表和下拉用同一份状态标出不可用的 provider。
- **模型目录**：两个文件分工——`config/models.yaml` 是**目录**（每个 provider 有哪些模型：`id`、显示名 `label`、`aliases`、API 的 `price`、codex 的 `reasoning_efforts` / `cli_default`、`deprecated`、`notes`），`data/config/ai.yaml` 是**选择**（`providers.<名字>.model` / `strong_model`、`tasks.<任务>.models`）。`ai.yaml` 照常单独加载，不依赖 `models.yaml`；选中的模型必须在对应 provider 的目录里，`pnpm config:check`（多一行 `ai.yaml ↔ models.yaml`）和设置页保存时检查：不在目录 / codex 推理强度不被模型支持 = 错误，选中已停用的模型 = 警告。
  - **按任务选模型**：`tasks.<任务>.models` 是"服务商 id → 模型 id"，只能给这个任务自己的 `order` 里直接列出的服务商指定（`api` 展开出来的不行）；路由试到该服务商时用它，否则用服务商默认模型。设置页的任务覆盖每行就是"服务商 + 模型下拉"。
  - **费用**：API 回复里的模型名先按目录的 `id`、再按 `aliases` 找单价；都对不上时按这个 provider 目录里最贵的输入价 / 输出价算（宁可多算，不让月预算漏掉），日志里有一条 warn，提示给它加 `aliases`。订阅 CLI 恒为 0。
  - **目录坏了**：路由在试 API provider 前检查这次要用的模型在目录里有单价；没有、或 `models.yaml` 读不了，就跳过这个 API provider（记为"未配置"，信息写明原因），订阅 CLI 不受影响。文件每次调用前按修改时间重读，写坏马上被发现，修好后下一次调用就恢复。
  - 设置页的详细用法见 [settings.zh.md](settings.zh.md)。

## 用量统计

每次模型调用（含失败、含输出不合格后的重试）写一行 `ai_usage`：模型、细分 token（缓存读写、推理）、耗时、结果、实际开支、折合 API 费用、对应岗位；CLI 没报告的 token 记为"未知"而不是 0。`/sources/ai-usage` 汇总，`pnpm ai:usage-backfill` 补空值。`models.yaml` 的订阅模型可写 `equivalent_price`（带 `source`），API 模型的 `price` 可加 `cached_input_per_mtok` / `cache_write_per_mtok`。完整说明和要加的配置见 [ai-usage.zh.md](ai-usage.zh.md)。

## 新模型上线清单

厂商出了新模型（不需要重启，保存后约 5 秒热加载；步骤也写在发布的 `config/models.yaml` 文件开头；`models.yaml` 是随产品发布的文件，先把它复制到 `data/config/models.yaml`，再改你的副本）：

1. 在 `data/config/models.yaml` 对应 provider 的 `models` 下加一条：`id` 写厂商文档里的模型名，`label` 写显示名。
2. API provider（anthropic / deepseek / mimo）必须写 `price`（美元 / 100 万 token 的输入价和输出价，以官网为准）；订阅 CLI 不写 `price`。
3. `pnpm config:check` 确认没有报错。
4. 先试一次：`pnpm ai:probe --provider <服务商> --model <id>`（`--model` 必须配一个且只配一个 `--provider`；输出里 `catalog=exact|alias|unknown` 说明回复里的模型名在目录里是否找到）。
5. 刷新 `/settings`，在 AI 标签对应服务商一节的"模型"下拉里选中它，保存。

旧模型下线：先在设置页换成别的模型，再给它加 `deprecated: true`（下拉不再列出；正在被选中时仍显示并标"已停用"，`config:check` 只警告）；确认没人用了再删掉这一条。厂商回复里报带日期的快照名时，把它加进该模型的 `aliases`。

## codex-cli 的调用方式和省额度设置

`providers.codex_cli` 下的新键（都在 `data/config/ai.yaml`，键名和 feature 名只允许 `^[a-z0-9_.]+$`，不合法的配置会被拒绝，不会往命令行里塞多余参数）：

- **工具始终关闭**，与 `trim_context` 无关。`codex exec` 没有工具白名单，所以 ai-worker 用 feature 自己做一个：每个已安装的 Codex 版本第一次用时运行一次 `codex features list`（`CODEX_HOME` 指向空的临时目录：不涉及登录，也不调用模型），把列出的**每一个** feature 都关掉，只留下几个只影响客户端怎么连 API 的（`enable_request_compression`、`content_item_kinds`、`compaction_image_budget`、`unbounded_connection_retries`、`fast_mode`、`api_key_model_discovery`、`auth_elicitation`、`guardian_approval`、`guardian_reuse_parent_compaction`；只认这些确切的名字，新的 `guardian_*` feature 和其他 feature 一样会被关掉）。所以 Codex 新版本加的 feature 默认是关的。另有一组固定的工具 feature（shell 和 exec、多 agent、apps 和插件、记忆、生成图片、浏览器和电脑操作、MCP elicitation、hooks、code mode、worktrees、web 搜索、权限申请、网络代理等）无论如何都关，列不出来时就只关这一组（运行 Codex 的进程，即 ai-worker 或 `pnpm ai:probe`，会对每个安装警告一次，因为这时新版本加的 feature 会保持开启；并发调用共用一次列表，失败的列表不缓存，下次调用会重试）；`disable_features` 里的名字再加上去。全部以 `-c features.<名字>=false` 传入（不用 `--disable`：名字未知时它会让 CLI 直接退出，`-c` 会忽略），后面跟 `web_search="disabled"`、`include_apply_patch_tool=false`、`tools.view_image=false`、`approval_policy="never"`。这些参数排在所有参数之后，`ai.yaml` 里的任何东西都不能把工具重新打开；`disable_features` 只能往里加。只读沙箱兜底。
- **`trim_context`**：true 时精简 Codex 自带的 agent 上下文。任务自己的 system prompt 写进临时目录的 `instructions.md`，用 `-c model_instructions_file="…"` 当基础指令，stdin 只放 user prompt，`config_overrides` 里的键值以 `-c 键=值` 传入（关技能清单、多 agent、权限/环境/协作说明）。实测同一条打分 prompt：输入 token 约 1.6 万 → 约 0.28 万。false = 旧行为（system + user 一起走 stdin，Codex 默认上下文），工具照样关闭。那组安全参数（只读沙箱、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、空临时目录）两种模式都保留。
- **`config_overrides`**：只传设为 `false` 的裁剪上下文开关：`skills.include_instructions`、`agents.enabled`、`include_*_instructions` / `include_*_context`。其他键或值（`mcp_servers.*`、`model_provider*`、`sandbox*`、`approval*`、`shell_environment_policy*`、`profile*`、`features.*` 等）一律忽略；ai-worker 启动时在日志里警告，doctor 的 `config.guards` 列出来。`web_search` 本来就始终关闭（只有任务 `salary_lookup` 例外：它得到 `web_search="live"`，其他 feature 仍全部关闭；Codex 的搜索没有域名限制），写了它会被静默略过，不警告。
- **`reasoning_effort` / `reasoning_effort_by_task`**：以 `-c model_reasoning_effort="…"` 传入，默认 `low`，可按任务覆盖（minimal|low|medium|high|xhigh|max|ultra）。`model` 不写就用 CLI 内置的默认模型（0.162.0 是 gpt-6.1-sol），**不是** `~/.codex/config.toml` 里选的（调用带 `--ignore-user-config`）。
- **`max_concurrency`**：同一进程里 codex 调用同时最多几个（默认 3），超出的排队；排队的调用被取消就直接退出队列，超时从进程启动算起，不含排队时间。
- **`auth_retry_seconds`**：第一次遇到登录（auth）错误，等这么多秒（默认 5）重试一次，再失败才算登录过期。这是为了多个进程共用 `~/.codex/auth.json`、同时刷新 token 的撞车。0 = 不重试。
- **`min_version`**：这个应用能用的最旧的 codex-cli（出厂 `0.122.0`）。它是下限，不是精确匹配：0.122.0 加入了 `codex exec --ignore-user-config` 和 `--ignore-rules`，每次调用都会带上它们；我们依赖的其他部分（`--ephemeral`、`model_instructions_file`、`codex features list`）都更早就有，更新的版本预期会保留它们。新版本加的 feature 会被 feature 列表关掉（见上），所以新装的版本不用重新验证。装得比它旧会有警告（`pnpm ai:probe`、ai-worker 启动日志、doctor 的 `config.guards`），不会阻断调用。原来的 `verified_version`（精确版本，任何不同都警告）已经取消；你自己的 `ai.yaml` 里还有它的话，会被静默忽略。

升级 Codex CLI 之后按下面的检查清单走（核对参数、跑一次极小请求看输入 token 是否仍在 3k 左右、`pnpm ai:probe`；只有这个应用的新版本告诉你时才调高 `min_version`）。推理强度（全局和按任务）可以在设置页的 codex-cli 一节用下拉改；其余这些键只在 YAML 里改，设置页不显示。

### claude-cli

`claude -p` 带 `--tools ""`（完全没有工具：不能跑 shell、不能读写文件、不能上网）、`--strict-mcp-config`（不加载任何设置文件里的 MCP server）、`--safe-mode`（不加载 CLAUDE.md、hooks、插件、技能）、`--no-session-persistence`（不往 `~/.claude/projects` 写任何东西）和自己的 `--system-prompt`，在空的临时目录里运行。

唯一的例外是任务 `salary_lookup`：不用 `--tools ""`，而是 `--tools "WebSearch,WebFetch"`（没有 shell、文件和 MCP）、对 `salary.yaml: lookup.allowed_fetch_domains` 里的主机（各自再加 `www.`）预先放行的 `--allowedTools WebSearch "WebFetch(domain:<主机>)" ...`，`--permission-mode dontAsk`（没有预先放行的工具调用一律拒绝），以及 `--setting-sources project`：你自己 `~/.claude/settings.json` 里的权限规则（比如放行 WebFetch）不会扩大这个名单。这是 CLI 自己的权限检查，不是网络边界；WebSearch 本身也不受这些域名限制。需要 `claude` 2.1.296 或更新（在 `-p` 下核对过）；版本更旧或读不出来时，查询直接失败，不会换别的参数去跑。

## ai-worker 不从 ai.yaml 接受的东西

`ai.yaml`、`notify.yaml`、`sources.yaml` 都能在网页上改，而 ai-worker（以及 runner）手里有你的 API key、Telegram token 和 CLI 登录态。所以进程自己再检查这些值，不管文件里写了什么。普通配置不会有任何感觉：出厂值都能通过检查。

- **CLI 命令**：`providers.claude_cli.command` 必须是 `claude`（在 `PATH` 上查找）或以 `/claude` 结尾的绝对路径，`providers.codex_cli.command` 必须是 `codex` 或以 `/codex` 结尾的绝对路径（Windows 上也可以是 `.exe` / `.cmd`）。相对路径和别的程序一律不启动；这个 provider 算作不可用并给出原因（`/sources`、`pnpm ai:probe`），doctor 的 `config.guards` 报 ❌。所以包装脚本也得叫 `claude` / `codex`（例如放在 `PATH` 上它自己的目录里）。
- **模型名**：claude-cli 和 codex-cli 的模型名只能含字母、数字和 `._:/[]-`，且不能以 `-` 开头，所以模型名永远不会被当成命令行选项。
- **codex 的 `config_overrides`**：只认上面的白名单键，且值必须是 `false`。
- **接收凭据的主机**：DeepSeek 和 MiMo 的 key（`providers.*.base_url`）、Telegram bot token（`notify.yaml telegram.api_base_url`），以及 JSearch、Tavily、Brave、Apify、Monid 的 key（`sources.yaml` 的 `api_base_url`）只通过 https 发往厂商自己的主机（`api.deepseek.com`、`api.xiaomimimo.com`、`api.telegram.org`、`jsearch.p.rapidapi.com`、`api.tavily.com`、`api.search.brave.com`、`api.apify.com`、`api.monid.ai`）；Gmail 登录（`sources.yaml sources.gmail`）只发往 `imap.gmail.com` 的 993 端口且 `secure: true`。这些请求不跟随重定向。别的地址会被拒绝：该 provider 不可用、不发 Telegram、该渠道这一轮失败，什么都不会发出去。确实在用代理或网关时，在 `.env` 里设 `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1`（ai-worker 和容器都读得到）；之后每个自定义主机都会被使用并在日志里警告，变量设着的时候 doctor 也一直给警告。

## 只能有一个 ai-worker

每个 ai-worker 启动时先拿一个 Postgres advisory lock（每个数据库一把）。第二个，例如服务（launchd 或 systemd）在跑时又在终端里运行 `pnpm ai-worker` 或 `pnpm ai-worker --once`，会打印 `another ai-worker is running against this database (job-radar ai-worker pid=… host=… since …)`，在碰队列之前以退出码 3 退出，所以第一个正在执行的请求不会被重新排队、重复执行。不带 `--once` 时它先等 `host_worker.already_running_wait_seconds`（默认 60 秒），免得服务管理器不停地重启它。局限见 [deploy.zh.md](deploy.zh.md#只能有一个-ai-worker)。想手动跑就先停掉服务（macOS：`launchctl bootout gui/$(id -u)/io.jobradar.ai-worker`；Linux：`systemctl --user stop job-radar-ai-worker.service`）。崩溃的 worker 留下的 `running` 请求，只由拿到锁的 worker 放回队列。数据库重启后，worker 在下一次心跳时重新拿锁；如果中间被另一个 worker 拿走了，它就自己退出。

## 翻译怎么工作

长 JD 按段落切成片段，一片一个请求，每片翻完立即存进 `translation_progress`。

- 一个 provider 在某一片上超时或被限流：这一片换下一个 provider，这条 JD 剩下的片不再试它（不会每片都白等一次超时）。
- 某一片失败：已经翻好的片保留；provider 级的问题（登录过期、全部不可用）立即停下，只有这一片的输出不合格则继续翻后面的。重试（"继续翻译"）只翻缺的片；全部完成才写入 `translations`。JD 文本变了，旧的片段作废。
- 页面显示"翻译中 (2/5)"和已翻出的部分；失败时给出真实原因（登录过期 / 超时 / provider 报错 / 限流 / 输出不合格 / 预算用完 / 没有可用 provider）和重试按钮。

## 排错

- `/sources` 的 AI worker 卡片显示"没有响应"：macOS 用 `launchctl print gui/$(id -u)/io.jobradar.ai-worker`，Linux 用 `systemctl --user status job-radar-ai-worker.service` 和 `journalctl --user -u job-radar-ai-worker.service`；再看 `data/logs/ai-worker.err.log`（macOS 上启动失败和崩溃在 `~/Library/Logs/job-radar/ai-worker.launchd.log`）；没装就 `scripts/ops/install-ai-worker.sh`。
- worker 在跑但打分失败：多半是订阅登录过期，在终端重新登录；日志里 `claude:` / `codex:` 两行显示它在 PATH 上找到了哪个可执行文件，找不到就重装（脚本会重新探测路径）。
- 只想处理一次队列：在项目目录运行 `pnpm ai-worker --once`。服务在跑时它会以退出码 3 退出（"another ai-worker is running"）：队列反正由服务处理。
- 某个 provider 显示 "must be claude …" / "is not started"，或 "points to … not …"：上面的防护拒绝了改过的 `command` 或 `base_url`；`pnpm run doctor`（`config.guards`）会说是哪个键。
