# 配置文件在哪里：默认配置 + 用户配置目录

Job Radar 的所有设置都是 YAML，分两层：

| 层 | 位置（环境变量，默认值） | 谁改 | 进 git |
|---|---|---|---|
| 默认配置 | `JOB_RADAR_DEFAULTS_DIR`，默认 `config/` | 只随产品版本变 | 是（随产品发布） |
| 用户配置 | `JOB_RADAR_CONFIG_DIR`，默认 `data/config/` | 你、网页（/settings、/interests、/sources/registry）、`pnpm config:*` | 否（`data/` 被忽略） |
| 画像 | `JOB_RADAR_PROFILE_DIR`，默认 `data/profile/` | 你、网页 /me | 否 |

相对路径按项目目录解析（不是当前目录）。Docker 里出厂默认配置是 web、runner 镜像的一部分：Dockerfile 把 `config/` 复制到 `/app/config`（属于 root，所有人可读，谁都不能写），并设置 `JOB_RADAR_DEFAULTS_DIR=/app/config`；那里不挂载任何东西。`scripts/ops/deploy.sh` 从要部署的提交的 `git archive` 构建镜像，所以容器里的默认配置正好是已提交的 `config/`，`config/` 的改动只有经过部署才会到容器里（单独 `git pull` 不会改变运行中的容器）。用户配置和个人画像是 bind mount（`compose.yaml`：web `./data/config:/app/data/config`，runner 同样挂载但只读）。宿主机的 ai-worker 从检出目录读 `config/`；`scripts/ops/install-ai-worker.sh` 把三个目录显式写进它的 launchd plist 或 systemd 单元。

`data/config/` 里的同名文件优先于默认配置，所以 `git pull` 永远不会动你的设置；几乎所有设置也都能在设置页上改。想快点上手，
`pnpm config:example` 可以套用一份现成的示例配置。

密钥（API key、Telegram token、Gmail 应用专用密码、网页口令的哈希）只放在 `.env`，不要写进 YAML。唯一要留意的例外：`sources.yaml`
里的 `jobspy.proxies` 可能含代理凭据（`user:password@host`），而每次备份的配置压缩包都包含这个文件，所以备份压缩包要妥善保管。
哪个来源要哪个 key：见 [installation.zh.md](installation.zh.md#2-可选创建-env)。

## 读哪一份

- 用户目录里**有**这个文件就读它，**没有**就读默认目录的。两层不合并：用户目录里的文件是整份生效的。
- 网页保存永远写用户目录；第一次保存一个只在默认目录里的文件时，以默认文件为底稿生成（默认文件的注释会带过去）。默认目录从不被写。保存时，文件里还没有的键如果取值就是 schema 的默认值，也不会写进去（否则会把默认值固定住，以后产品更新改了默认值你也拿不到）；文件里已有的键会保留，与默认值不同的取值才会写入。
- 热加载同时盯两层：用户文件新出现、被删除（退回默认）、默认文件变了（你没有自己那份时）都在约 5 秒内生效。容器里的默认配置在镜像里，只随新镜像（部署）改变；Docker 之外（`pnpm dev`、宿主机的 ai-worker）`config/` 里的文件改了会这样生效。runner 和 ai-worker 盯所有配置文件（包括 `me.yaml`、`preferences.yaml`），并在每轮周期和每个请求开始时再读一遍，所以改动（比如在设置向导或 `/me` 里保存的市场）在下一轮周期就生效，即使它紧接着就开始，也不用重启。
- web 和 MCP server 没有 watcher，所以自己检查文件：读取某个配置时，如果距上次检查已超过 5 秒，会先把它已加载的所有配置重新读一遍，所以手工改的文件（或别的进程改的）下一次打开页面就能看到，不用重启。文件无效时被忽略（保留上一份有效值），日志里只报告一次。`JOB_RADAR_CONFIG_POLL_MS`（默认 `5000`，单位毫秒，设在该进程的环境变量里）就是这个间隔，也是 watcher 的轮询间隔；设为 `0` 会关闭这项检查和 watcher 的轮询（watcher 仍会响应文件事件）。
- `pnpm config:check` 逐个文件写出读的是哪一层：`(user)`、`(default)`、`(user override of a shipped file)`。

## 两类文件

| 类 | 文件 | 首次初始化 | 产品升级时 |
|---|---|---|---|
| `user` | schedule、search、sources、ai、notify、interests、ui、breakdown、resume、insights、language、setup、salary（[salary.zh.md](salary.zh.md)）、mcp（[mcp.zh.md](mcp.zh.md)）、writer（[application-writer.zh.md](application-writer.zh.md)） | 从默认目录复制到用户目录，之后归你 | 不会自动改你的文件；格式变化由迁移（`config_version`）带过去 |
| `shipped` | models（模型目录和价格）、pipeline（解析规则、城市和技能表）、pipeline-board（看板布局和卡片显示）、job-search（岗位查询解析与匹配设置）、job-archive（再次出现规则）、signal-presets（`/interests`“新增类别”对话框的预设，见 [signals.zh.md](signals.zh.md#添加你自己的兴趣点)） | 不复制，一直读默认目录的 | 跟着产品更新 |

产品升级新增的 `user` 文件会在下次启动时从默认目录复制过来；如果用户目录里本来就有配置（老安装），可以改为写入保持原有行为的版本
（`language.yaml`：中文，见 [languages.zh.md](languages.zh.md)）。初始化向导用同一个"老安装"判断。

想改 `shipped` 文件：把它复制到用户目录再改（整份覆盖）。代价是产品以后对这个文件的更新不再生效：`pnpm config:check` 和 doctor 的 `config.layers` 会一直提示"你覆盖了 models.yaml"。想重新跟随产品：删掉用户目录里那份。

市场包（`config/packs/<id>/`：国家、城市、本地语言规则）也按 `shipped` 处理：`data/config/packs/<id>/` 里的副本整包替换发布的那份。见 [market-packs.zh.md](market-packs.zh.md)。

画像文件 `me.yaml`、`preferences.yaml` 和 `stories.yaml`（经历素材库，见 [application-writer.zh.md](application-writer.zh.md)）在 `data/profile/` 里，在 `/me` 页编辑。`preferences.yaml` 里可选的 `deal_breakers` 列表
（在任何 AI 调用之前否决岗位的规则）见 [deal-breakers.zh.md](deal-breakers.zh.md)；它的上限在 `pipeline.yaml: filter.deal_breakers`。

运行时的 profile 读取可在内存里使用 `config/profile.example/`，不创建用户文件。原文检查、doctor 和 watcher 仍区分缺失文件与已保存文件；模板不属于默认配置层。

## 再次出现（`job-archive.yaml`）

`config/job-archive.yaml` 是出厂文件。要覆盖，整份复制到 `data/config/job-archive.yaml`，保留
`config_version: 1`，再修改用户副本。用户文件整份替换出厂文件；删除用户副本即可重新跟随产品更新。
两个键都必填，未知键或越界值都会被拒绝。

| 键 | 出厂值 | 含义 |
|---|---|---|
| `relist.min_gap_days` | `14` | 整数 0–3650：两次来源列出的最小间隔，期间还须观测到缺席。`0` 关闭再次出现记录，但继续维护最后列出。 |
| `relist.badge_days` | `14` | 整数 1–365：再次出现标签、`/jobs?relisted=true` 筛选和 Today 提示的窗口。 |

这两个设置不改变打分或硬过滤的配置指纹，也不会增加 AI 工作。若回退到不维护最后列出的旧代码后再次升级，
先临时设 `relist.min_gap_days: 0` 跑一轮采集，刷新基线，再恢复选定值。旧代码忽略此文件和新增数据库列；
回退时保留这些列。

maintenance 连续 `relist.min_gap_days` 天或更久没有运行、而采集一直在跑时也一样：恢复后的第一次 maintenance 可能成批
误记再次出现。在它运行前先临时设 `relist.min_gap_days: 0` 跑一轮，再恢复选定值。`pnpm reprocess` 重放的是已存的原帖，
从不记录再次出现。

## 申请看板（`pipeline-board.yaml`）

这是 `config_version: 1` 的 shipped 文件。现有安装直接读取默认目录，无需迁移。
需要自定义时，将整份文件复制到用户配置目录；该副本会覆盖以后随产品发布的更新。
六个键全部必填；未知键、无效密度和超出下列范围的值会被拒绝，错误包含字段路径。

| 键 | 出厂值 | 允许值 | 用途 |
|---|---|---|---|
| `density.default` | `compact` | `compact`、`comfortable` | 默认卡片密度 |
| `density.remember_days` | `365` | 整数 1–3650 | 密度选择保留天数 |
| `compact.title_lines` | `2` | 整数 1–4 | 紧凑卡片标题最多行数 |
| `compact.next_action_lines` | `1` | 整数 1–3 | 紧凑卡片下一步最多行数 |
| `layout.column_min_width_rem` | `14` | 10–24 | 桌面列最小宽度，单位 rem |
| `layout.board_min_height_rem` | `24` | 12–60 | 矮屏看板最低高度，单位 rem |

所有键均已生效。紧凑卡片按配置限制标题和下一步行数，不缩小字号。工具栏切换密度后，在当前浏览器的 `jr_board_density` cookie 中保存 `density.remember_days` 天。cookie 缺失或非法时使用 `density.default`；首个响应由服务端按所选密度渲染。

## 岗位搜索设置（`job-search.yaml`）

这是岗位查询解析器的 shipped 配置，与 `search.yaml` 中的采集条件分开。
它用于 /jobs、Today 已存视图搜索、视图趋势、快速打开接口和 MCP search_jobs。
所有键均必填，未知键会被拒绝；默认值只写在 YAML 中。

- `query`：输入长度（`max_chars`，整数 10–200；200 也是 MCP `query` 和已存视图 `q` 的上限）、不同词项上限（`max_terms`，整数 1–50）、
  独立 CJK 片段的最少字数（`cjk_min_chars`，整数 1–10），以及 `all_scope_timeout_ms`（整数 1–120000）：
  同时搜索职位说明（`searchIn=all`）时每条列表或计数查询的时间上限。任一查询超时后，/jobs 在列表上方显示“全文搜索超时”，
  保留成功加载的结果，并将无法获取的计数显示为“—”。
  MCP `search_jobs` 返回 `search_timeout` 错误。
- `matching.prefix_min_chars`：允许前缀匹配的最少词长，整数 1–20。
- `ranking`：字段权重 `weights`（`title`、`company`、`location`、`country`、`description`、`translation`，各 0–100）
  与前缀折扣 `prefix_factor`（0–1），用于相关度排序，每个词只取命中字段的最高权重，前缀文本匹配乘以折扣。
- `countries`：非空语言标签列表 `name_locales`、仍按普通文本处理的大写两字母歧义代码 `ambiguous_codes`，
  以及代码到非空名称列表的 `extra_aliases`。国家名称来自市场国家表、其别名和 `Intl.DisplayNames`；
  `match: false` 的国家不参与自由文本识别。
- `palette`：`min_chars`（整数 1–10）、`limit`（整数 1–50），用于快速打开搜索接口。

需要自定义时，将整份文件复制到用户配置目录；该副本会覆盖以后随产品发布的更新。

搜索默认匹配标题、公司显示名与别名、每个地点的 city/label，以及识别出的国家。
`/jobs?searchIn=all` 还搜索原始职位说明和来源哈希有效的译文，译文标记不参与匹配。
查询时对字段做 NFKC 归一，不改存储。短拉丁词只整词匹配，长词允许词首前缀；引号短语限于同一字段；
`C++` 等符号词按字面匹配；以点开头的词（如 `.NET`）也匹配 `ASP.NET`。国家名同时匹配文本，非歧义裸代码只匹配国家代码，歧义代码仍是普通文本。
只输入一个代码（`DE`、`de`）时当国家；多词查询里只有大写输入的代码才当国家（`engineer DE`），所以 `chef de projet`
里的 `de` 仍是普通词。给代码加引号（`"DE"`）就按文本搜索。
`/jobs?country=DE&country=FR` 按国家代码精确筛选（OR）。country 和 searchIn 只在 URL 中，不存进视图。
有搜索词且未显式选排序时，固定按相关度降序，忽略 dir；其他排序默认值不变。

非 ASCII 字母的大小写不敏感（`ü`/`Ü`、`é`/`É`）取决于数据库 locale。Docker 部署的数据库用 `en_US.utf8`，会折叠大小写；
用 `C` locale 建的数据库只折叠 ASCII 字母。

## 命令

```bash
pnpm config:init                  # 建用户目录，复制缺的 user 文件和画像模板；已有的不动（可重复运行）
pnpm config:init --from <目录>     # 从别的目录复制（旧安装迁移用），并复制与默认内容不同的 shipped 文件
pnpm config:migrate               # 列出要迁移的文件和 diff，不写
pnpm config:migrate --write       # 迁移：先把要改的原文件备份到 data/config/.backup/<时间>/，再写
pnpm config:check                 # 校验两层（默认目录的文件即使被覆盖也要合法），写出每个文件读的是哪层和出厂配置标识
pnpm config:check --effective     # 逐个文件：读的是哪层，以及生效值的哈希（`--json` 输出机器可读的列表；见下）
pnpm config:example               # 列出示例配置；`pnpm config:example <id> [--dry-run]` 套用其中一个（见下文）
```

web 和 runner 启动时会补缺，升级冻结期间跳过补缺。已有安装在 `scripts/ops/deploy.sh` 第 4 步先预览迁移、在内存里运行 `config:check` 并检查 compose config，通过后才冻结写入；第 11 步 `config-write` 核对 worker 持有者及宿主进程后才补缺、写迁移。首装在第 4 步运行 `config:init`，不冻结。不支持冻结协议的旧目标沿用第 4 步写盘的旧流程，见[回退说明](upgrade.zh.md#downgrade-pre-config-freeze)。

只有认识冻结协议的 web 版本从第 4 步起拒绝保存。首次部署本版本时，旧 web 会一直运行到第 8 步；它仍写旧格式文件，没有危害。等待 `config-write` 补文件期间，读取方会按当前安装状态选择默认值，例如已有安装的语言默认值。

### 薪资（`salary.yaml`）

薪资基准只用岗位写明的薪资，AI 查询只用于显示。`salary.yaml` 从 `config_version: 1` 升到 `2` 的配置迁移会删除
`benchmark.include_ai_lookups` 和它的注释。`scripts/ops/deploy.sh` 第 4 步预览，第 11 步 `config-write` 才写盘。手动升级时，先停掉旧消费者，再运行
`pnpm config:migrate` 看这一步会删掉什么，再运行 `pnpm config:migrate --write` 写回（原文件保存在 `data/config/.backup/`）。
旧文件加载时会在内存里迁移；在 v2 文件里加回这个键会因“未知键”而校验失败。卡片说明见 [salary.zh.md](salary.zh.md)，
升级和回滚说明见[更新日志](../CHANGELOG.md)。

### LinkedIn Monid（`sources.yaml`）

默认级联为 Bright Data → Apify → Monid → session → guest。Monid 需要 `.env` 中的 `MONID_API_KEY`，
供应商、接口名和 API 地址是受保护键。sources 迁移 **3 → 4** 补上配置块，预算为 `min(5, 全局上限)`，
只在恰好是旧默认级联时插入；自定义顺序保持不变。回退到只支持版本 3 的代码前，先从
`data/config/.backup/` 恢复 `sources.yaml`，或删掉 Monid 块和级联条目并将 `config_version` 改回 `3`。
钱包设置、记账、冒烟和停止行为见 [Monid](monid.zh.md)。

### 付费交付账本（`delivery-audit.yaml`）

这个随产品发布的文件控制[付费交付账本](sources.zh.md#付费交付账本)。要修改时，将整个文件复制到 `data/config/delivery-audit.yaml`；用户副本会整体替代出厂文件。

| 键 | 出厂值 | 含义 |
|---|---|---|
| `config_version` | `1` | 配置版本。 |
| `scope.channel_kinds` | `[paid]` | 覆盖的通道类型。 |
| `scope.exclude_channels` | `[]` | 从范围中排除的通道 ID。 |
| `checkpoint.write_timeout_ms` | `5000` | 账本写入的数据库语句和锁等待上限，单位毫秒。失败路径最终化先完成回滚，再单独收尾运行；备用写入也使用同一上限。 |
| `retention.days` | `45` | 仅账本条目的保留期，绝不作用于原始岗位；运行摘要保留。 |
| `retention.warn_bytes` | `524288000` | 留存原文的字节数超过此值时 doctor 告警，runner 可提前修剪过期条目。 |
| `prune.every_minutes` | `60` | 定期修剪间隔，单位分钟。 |
| `prune.batch_size` | `2000` | 每条语句最多删除的过期条目数。 |
| `prune.statement_timeout_ms` | `5000` | 每条修剪语句的超时，单位毫秒。 |

阈值不会跳过新条目，也不会删除未过期条目。数据库备份会随账本增大：每天 1500 条付费记录、保留 45 天约 135 MB，实际取决于留存原文的数量；一次格式异常的供应商响应就可能额外增加几十 MB。

### 操作日志（`activity-log.yaml`）

这个随产品发布的调优文件控制[操作日志](sources.zh.md#操作日志)。修改时将整份文件复制到 `data/config/activity-log.yaml`；用户副本会整体替代出厂文件。各项默认值和具体键见随产品提供的 `config/activity-log.yaml`。

| 键 | 含义 |
|---|---|
| `enabled` | 新记录的开关；关闭后，已经开始的工作仍会写完。 |
| `retention.days` | 非进行中条目从最后活动起的保留天数，默认 30 天。 |
| `retention.max_events` | 事件数上限；超出后从最旧的非进行中条目开始删除。 |
| `capture` | 每个记录的事件采集上限。 |
| `writer` | 队列、批次、刷写、超时和重试的调优项。 |
| `prune` | 核对与修剪的间隔、每个事务删除的行数和条目数。 |
| `ui` | 分页、刷新、初始时间范围和删除时间上限。 |
| `liveness` | 判断进程存活的心跳时效和启动宽限期。 |

修改后无需重启即可生效。真正进行中的工作不会被修剪。

### setup.yaml

`setup.yaml` 记录首次设置的状态（`completed_at`、`completed_by`、`steps`），由设置向导和 `pnpm run setup` 写入。全新安装时它是
"未完成"（打开任何页面都进入 `/setup`，runner 不跑定时轮次）。`config:init`（以及 web / runner 启动时）发现用户目录里已经有配置
文件、却没有 `setup.yaml` 时，会写入一份已完成的（`completed_by: existing_install`），所以老安装永远不会看到向导。读不了的文件按
已完成处理。见 [setup.zh.md](setup.zh.md)。

## 示例配置

随产品发布的默认配置是刻意中性的：一组占位关键词（`targets: [Software Engineer]`），没有公司招聘页（`ats_boards: []`），
招聘页通道没有额外的职位名词（`include_terms: []`），时区 `America/New_York`，画像模板里是一个美国的示例市场。设置向导
（或 `pnpm run setup`）会用你的回答替换它们。

现成的配置以示例的形式放在 `config/examples/<id>/`：每个目录有一个 `example.yaml`（名称、说明）和几个 `user` 文件的
局部副本，只写它要设的键。不套用就不会被读取：

```bash
pnpm config:example                                  # 列出
pnpm config:example ai-engineering-europe --dry-run  # 只看会改哪些设置
pnpm config:example ai-engineering-europe            # 套用：先把要改的文件备份到 data/config/.backup/<时间>/，再写
```

套用时把每个文件合并进你在 `data/config/` 里的那份（注释保留）：映射按键合并，列表整个替换；`ats_boards` 例外，只补上你
还没有的招聘页；`keyword_groups` 只有还是发布时的占位内容时才整组替换，否则把示例的关键词组加在你的旁边。会替换掉你已有条目的列表会先给出警告（--dry-run 也会）。重复套用不会再改。

| 示例 | 设什么 |
|---|---|
| `ai-engineering-europe` | `search.yaml`：AI / LLM / ML 工程、Forward Deployed 和 AI 解决方案岗位的关键词组；`sources.yaml`：招聘网站和公司招聘页通道的 AI 职位名词，十家示例公司的招聘页（Greenhouse、Lever、Ashby、Personio、SmartRecruiters）；`ai.yaml`：这些职位名的翻译词表。市场、城市和时区不在里面：在向导里选（这个示例是按德国市场包、Berlin、`Europe/Berlin` 做的）。 |

想用同样的方式分享你自己的配置：在旁边放一个目录，写好 `example.yaml` 和局部文件即可。

## 受保护的键（只能手动改）

有些值决定宿主机运行哪个程序，或者凭据发往哪里。runner 和宿主机上的 ai-worker 带着 `.env` 里的全部密钥运行，所以 web
（设置表单、高级编辑器、设置向导、来源登记）不能改这些键，只能在用户配置目录的文件里手动改：

| 文件 | 受保护的键 |
|---|---|
| `ai.yaml` | `providers.*.command`（`claude` / `codex` 可执行文件）、`providers.*.base_url`（OpenAI、OpenRouter、DeepSeek、MiMo）、`providers.codex_cli.config_overrides`、`providers.codex_cli.disable_features`、`providers.codex_cli.trim_context` |
| `notify.yaml` | `telegram.api_base_url` |
| `sources.yaml` | 所有 `base_url`、`api_base_url`、`eu_api_base_url`，`jobspy.url`，`jobspy.proxies`，`sources.gmail.host` / `port` / `secure`，`linkedin.session.site.auth_file`，`linkedin.apify.actor_id`，`linkedin.monid.provider`，`linkedin.monid.endpoint` |
| `resume.yaml` | `claude_command`、`claude_args`、`resume_kit_path`、`master_resume_path`、`pdf_dir`、`jd_export_dir`、`jd_export_host_dir` |
| `ui.yaml` | `web_access` 下的全部键（登录限制，见[网页访问](#网页访问可选口令监听地址和端口)） |

- web 保存时，如果受保护键的值既不同于文件里的值，**也**不同于出厂默认值，就拒绝保存。写回文件里已有的值或出厂默认值（例如"恢复默认"，或旧文件还没有的键）是允许的。
- 设置表单里这些字段是只读的，带锁定说明；高级编辑器在文本上方列出它们，改动会在对应行标成问题（"受保护的键"），保存按钮不可用。
- 如果确实要让 web 改（例如只有你自己能访问 web 的机器），在 `.env` 里设 `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` 并重启 web（`docker compose up -d web`）。表单里的字段仍显示为锁定，请用高级编辑器改。
- 清单在 `src/lib/config/protected-keys.ts`。

### 使用时再检查一次

上面的锁定是 web 这一侧。ai-worker 和 runner 也不信任文件（它可能是手动改的，或者设了 `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1`），所以有几个值在使用的地方再检查一次，不管文件里写了什么（出厂值总能通过）：

- `ai.yaml providers.claude_cli.command` / `providers.codex_cli.command` 必须是 `claude` / `codex` 这个可执行文件（裸名字或绝对路径）；`providers.codex_cli.config_overrides` 只保留设为 `false` 的裁剪上下文开关；不管 `disable_features` 和 `trim_context` 怎么写，codex 的工具限制始终生效。
- 接收凭据的服务（OpenAI、OpenRouter、DeepSeek、MiMo、Telegram、JSearch、Tavily、Brave、Apify、Monid）的 `base_url` / `api_base_url` 必须指向厂商自己的主机，`sources.gmail` 必须是带 TLS 的 `imap.gmail.com:993`，除非 `.env` 里设了 `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1`。带凭据的请求不跟随重定向。
- claude / codex 的模型名必须是普通名字（没有空格，不以 `-` 开头）。

两个放行开关互不相干：`JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` 只让 web 能写这些键，`JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` 让进程把凭据发往你自己的主机。检查不通过时会怎样，见 [ai-providers.zh.md](ai-providers.zh.md#ai-worker-不从-aiyaml-接受的东西)；doctor 的 `config.guards` 会列出每个被忽略或拒绝的值。

## 哪些主机名能访问 web（`JOB_RADAR_ALLOWED_HOSTS`）

web 只响应发往已知主机名的请求，用来防 DNS rebinding：别的网站把自己的域名重新解析到 `127.0.0.1` 后，它的页面就能像仪表盘自己一样访问仪表盘。不用任何设置就允许的：

- `localhost`、`127.0.0.1`、`[::1]`（任意端口）；
- `*.ts.net`（Tailscale：`tailscale serve`、MagicDNS）。

这个清单不取自 web 能写的任何配置文件：`notify.yaml: public_base_url`（Telegram 消息里的链接）不会加入它的主机名。`Host`、`X-Forwarded-Host` 或 `Origin` 是其他名字的请求会得到 `421 Misdirected Request` 和一段简短说明。会改动东西的请求（表单、Server Action，GET / HEAD 以外的一切）还必须来自它发往的同一个地址：另一个允许的主机上的页面，例如 tailnet 里的另一台机器、`localhost:5173` 上的另一个程序，算另一个网站，同样拒绝。除请求自己的主机外，只接受 `JOB_RADAR_ALLOWED_HOSTS` 里列出的来源。如果你用别的名字访问 web（Caddy、nginx 等反向代理，局域网主机名或 IP），把它加进 `.env` 并重启 web：

```bash
JOB_RADAR_ALLOWED_HOSTS=jobs.example.com,*.home.example,192.168.1.20
```

用逗号分隔主机名或 IP 地址（IPv6 加方括号）；`*.example.com` 允许 `example.com` 下的所有名字（`*.` 后面至少要两段，`*.com` 会被忽略）；`name:port` 只允许那个端口。

反向代理**必须**把公开的主机名传下去，放在 `Host` 或 `X-Forwarded-Host` 里（Caddy 默认这样做；nginx 用 `proxy_set_header Host $host;` 或 `proxy_set_header X-Forwarded-Host $host;`）。否则表单和操作会被拒绝，因为浏览器的来源和 web 看到的地址对不上。Docker 镜像里 Server Actions 的来源清单在构建镜像时就固定了；传下主机名就不需要它。

## 网页访问：可选口令、监听地址和端口

默认情况下 web 只监听 `127.0.0.1:3000`，没有登录：在你自己的机器上别人访问不到，手机通过 `tailscale serve` 进来。口令是可选的。只要除你之外还有人能打开面板（共享的 tailnet 里经 `tailscale serve`、局域网、反向代理之后），就设一个。

```bash
pnpm web:password            # 输入两次（不回显），打印一行
# JOB_RADAR_WEB_PASSWORD_HASH=scrypt:131072:8:1:...   -> 贴进 .env
docker compose up -d web     # 创建容器时 web 读取 .env
```

变量（都在 `.env` 里，从不放在 web 能写的文件里）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `JOB_RADAR_WEB_PASSWORD_HASH` | 空 | `pnpm web:password` 生成的 scrypt 哈希（推荐）。空 = 不登录。 |
| `JOB_RADAR_WEB_PASSWORD` | 空 | 简易写法：明文口令。两者都设时哈希生效。doctor 会建议改用哈希。 |
| `JOB_RADAR_WEB_BIND` | `127.0.0.1`（compose） | compose 在宿主机上发布 web 的地址，也是 `pnpm start` / `pnpm dev` 监听的地址。`0.0.0.0`（或局域网地址）会向网络开放：先设口令，否则 doctor 的 `compose.web` 失败。在 compose 之外不设 = 监听所有网卡（本机也不免登录，见下文）。 |
| `JOB_RADAR_WEB_PORT` | `3000` | web 在宿主机上的端口（第二个实例要用自己的端口，见 [multiple-instances.zh.md](multiple-instances.zh.md)）。doctor 会跟随这两个变量。 |
| `JOB_RADAR_SESSION_SECRET` | 自动生成 | 签名会话 cookie 的密钥。不设时，首次使用会把 32 个随机字节写进 `data/config/.web-session-secret`（权限 0600）。只有要在多台机器间共享会话时才设（至少 32 个字符）。 |
| `JOB_RADAR_WEB_LOCAL_LOGIN` | 空 | `1`：本机发出的请求也要口令（见下文）。web 能从本机以外访问时推荐设置。 |

设了口令之后：

- 没有会话的访客打开页面会跳到 `/login`，登录后回到原页面。在此之前其他请求（API、表单、后台请求）一律返回 `401`。`/api/health` 始终开放，供健康检查使用。
- 会话有效期为 `ui.yaml: web_access.session_days`（30 天）；cookie 为 `HttpOnly`、`SameSite=Lax`。经 https 到达时（`tailscale serve` 就是 https）cookie 名为 `__Host-jr_session` 并带 `Secure`（浏览器只经 https 把它发给这一个主机）；明文 http 下名为 `jr_session`。这个 cookie 名出现之前经 https 建立的会话不会沿用：升级到那个版本后，经 https 访问的每台设备都要再登录一次。退出登录按钮在侧栏底部（手机上在菜单里）。
- 结束所有会话（手机丢了、用过别人的浏览器）：**设置 → 已登录的浏览器 → 退出所有设备**会一次让所有浏览器退出登录，包括当前这个。它把 `data/config/.web-session-generation` 里的计数加一；之前发出的会话从此都被拒绝，其他不变。改口令也会让所有会话失效；删掉 `data/config/.web-session-secret`（或改 `JOB_RADAR_SESSION_SECRET`）再 `docker compose up -d web` 也一样。
- 失败的登录在校验口令之前就会被限制：同一来源在 `login_window_minutes`（15）分钟内失败 `web_access.login_max_failures`（5）次，锁定 `login_lockout_minutes`（15）分钟。来源取 `X-Forwarded-For` 的最后一个地址，即最近一跳看到的地址（`tailscale serve` 会把它设成设备的 tailnet 地址）。窗口内所有来源合计失败达到 `global_max_failures`（30）次后，之后每失败一次，所有登录都要等待：先等 `global_delay_seconds`（2）秒，每次翻倍，最多 `login_lockout_minutes`。仍持有有效会话的浏览器不受这个等待影响。同时最多进行 `max_concurrent_logins`（4）次校验（每次会短暂占用约 128 MB 内存）。web 日志会记下每次锁定和每次开始等待，但从不记录口令或地址。`min_password_length`（10）是 `pnpm web:password` 接受的最短口令。这些键受保护：在 `data/config/ui.yaml` 里手动改。
- 从别的机器经明文 http 登录时，登录页会显示警告：口令会不加密地经过网络。请用 `tailscale serve`（https）或 https 反向代理。
- 读不懂的哈希（复制不全、旧格式）**不会**关闭登录：谁都登录不了，登录页提示“现在无法登录”，doctor 的 `web.access` 检查失败。重新运行 `pnpm web:password`。

**本机访问免口令。**请求点名本机（`Host` 和 `X-Forwarded-Host` 是 `localhost`、`127.0.0.1` 或 `[::1]`）、转发的客户端地址是回环地址（在 compose 里私有地址也算：那是 Docker 网关）、不是经代理以 https 进来的、并且不带任何只有代理才会加的请求头时，可以跳过登录，所以本机上的浏览器不需要口令。这些请求头客户端都能自己伪造，所以只有 `JOB_RADAR_WEB_BIND` 设成回环地址、也就是只有本机能连上时，这项豁免才开启：

- compose 总会设置它（不改就是 `127.0.0.1`），并把端口发布在那里；
- `pnpm start` 和 `pnpm dev` 让服务器监听 `JOB_RADAR_WEB_BIND`（传了 `-H <地址>` 时用那个地址）。两者都没有时监听所有网卡，这时**每个**请求都要口令，`http://localhost:3000` 也一样。要保留豁免，在 `.env` 里设 `JOB_RADAR_WEB_BIND=127.0.0.1`；设了口令、web 不在 compose 里运行且这个变量没设时，`pnpm run doctor` 会给出警告（`web.access`）；
- 这里不支持直接运行 `next start`：它不理会 `JOB_RADAR_WEB_BIND`，监听所有网卡，`.env` 里写着 `JOB_RADAR_WEB_BIND=127.0.0.1` 时网络上任何人都能自称 `localhost`。请用 `pnpm start`。它通过开发依赖 `tsx` 启动 Next：要在用普通 `pnpm install` 安装的检出里运行，不能是 `pnpm install --prod`。

只要不是回环地址，豁免就关闭。

**规则：`JOB_RADAR_WEB_BIND` 必须写 web 实际发布的地址。**web 只通过它知道自己能被网络访问。用别的方式发布（改 `compose.yaml` 的 `ports:`、compose override、端口转发）而这个变量还是没设或 `127.0.0.1`，本机免登录就仍然开着；doctor 的 `compose.web` 检查会失败并提示“本机免登录仍然开着”。把 `JOB_RADAR_WEB_BIND` 设成发布的地址（并设口令）。

剩余风险：本机上任何把连接转给 web 的东西，在 web 看来都是本机。包括同一 compose 网络里的其他容器、单纯的 TCP 转发（`tailscale serve --tcp`、`socat`、`ssh -R`、路由器或 VPN 转发到这台机器的端口），以及本机上被你配置成发送 `Host: 127.0.0.1` 且不带转发头的反向代理。正常 https 模式的 `tailscale serve` 是安全的：它会加转发头，经它进来的访客总要口令。**web 能从本机以外的任何地方访问时，设 `JOB_RADAR_WEB_LOCAL_LOGIN=1`**：所有请求都要口令，宿主机上也登录一次即可。

没设口令时，只要面板是从别的机器打开的（或监听了回环以外的地址），每页顶部都会有红色横幅提示，doctor 的 `web.access` 检查也会给出警告。

## 谁能读这些文件

web 和 runner 以 `0600`（仅属主）写配置文件：`data/config/*.yaml` 里可能有 token，`data/profile/` 里是你的个人画像。Linux 上容器以 `PUID:PGID`（默认 `1000:1000`）运行，这个用户必须拥有 `data/`；见 [host-setup.zh.md](host-setup.zh.md#10-linux)。macOS 上的 Docker Desktop 会自己映射属主。

两个浏览器标签页（或手机和电脑）同时编辑同一个设置表单或个人画像时，第二次保存会被拒绝（文件已在别处改过），表单显示已保存的值，而不是覆盖第一次的保存。web 每次保存配置文件，还会把之前的文本留在 `data/config/.backup/editor/`（高级编辑器的备份，每个文件保留 `ui.yaml: config_editor.backups_keep` 份）。

## 版本和迁移（`config_version`）

- 每份配置可以在顶层写 `config_version: <整数>`，不写 = 1。
- 代码对每份文件有一个当前版本（迁移步骤 `src/lib/config/migrations/<文件>/NNN-*.ts` 最后一步的 `to`）。
- 文件**比代码旧**：读取时先在内存里迁移再校验，照常工作；doctor 提示运行 `pnpm config:migrate --write` 把迁移写回（注释保留，原文件进 `.backup/`）。
- 文件**比代码新**（代码回退了）：明确报错（`ConfigError`，doctor ❌），不会猜。升级代码，或从 `data/config/.backup/<时间>/` 拿回迁移前的文件。
- 默认目录的文件随产品发布，永远是当前版本（`config:check` 检查）。

### 比较生效配置（`config:check --effective`）

`pnpm config:check --effective` 每个配置文件打印一行：读的是哪层（`user` / `default`），以及加载器得到的值（内存里迁移、校验、填上默认值之后）的规范哈希。键的顺序、注释、引号和 `config_version` 不影响哈希，值不同哈希就不同。升级或手改前后各跑一次：哈希相同，生效配置就相同。读不出来的文件标 `✗` 并给出错误（文件和字段，不含内容），命令退出 1。`--json` 输出 `{"files": [{name, file, layer, hash, error}]}`。

### YAML 标签

解析器不认识的标签（`!foo`、拼错的 `!unset`、`!!int x`）在所有读配置文件的地方都是错误，并指出行号：加载器、设置页和高级编辑器、迁移、示例配置、来源导入。以前的版本只警告，并把值当字符串读。`!unset` 标签留给以后的版本，现在会被拒绝，提示“not supported by this version”。

写迁移（开发者）：在 `src/lib/config/migrations/<文件名>/NNN-slug.ts` 导出一个 `{ from, to, description?, migrate(doc) }`（`to = from + 1`，`migrate` 原地改 yaml 的 `Document`，保留注释，不做 I/O），在 `migrations/index.ts` 的 `CONFIG_MIGRATIONS` 里按顺序登记，同时把默认目录里那份文件改成新格式并写上新的 `config_version`。契约见 `src/lib/config/migrations/types.ts`。

## 出厂配置标识

默认配置目录（`config/`，或 `JOB_RADAR_DEFAULTS_DIR`）有一个标识：对目录文件清单算的 sha256。清单每个普通文件一行
`<sha256>  ./<相对路径>`，按路径的字节顺序排序（`LC_ALL=C`）。任何层级的 `.DS_Store` 和 `._*` 文件都不算；符号链接，或文件名里有换行或
反斜杠，直接报错。给人看的是前 12 个字符。在目录里用 shell 算出同一个标识：

```bash
cd config && find . -type f ! -name .DS_Store ! -name '._*' | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum
```

（macOS 上没有 `sha256sum` 时用 `shasum -a 256`）。改了出厂文件的内容、改名、加文件或删文件，标识都会变。

- `pnpm config:check` 在画像那行之后写出它：`shipped:  config  c86995b8f48f`（先目录，再短标识）。目录算不出标识时
  `config:check` 失败。
- 运行中的进程把自己用的标识报告到数据库（`runtime_state` 键 `shipped_config:<web|runner|ai-worker>`：完整标识、目录、主机名、PID 和
  进程启动时间；这一行的时间是数据库时钟）。web 启动时报告一次，没成功之前每次 `/api/health` 请求再试（每次最多等 `schedule.yaml doctor.probe_timeout_seconds`，卡住的写入会被放弃、下次再试）；runner 和 ai-worker（服务方式）
  启动时报告，之后每次心跳刷新，受心跳的时间上限约束。报告失败只在该进程日志里警告一句（`could not report the shipped config`），不会停掉进程，
  也不算心跳失败。
- `pnpm run doctor` 的 `config.shipped` 检查（"数据"组）显示每个进程的标识，并核对每份报告是否来自现在运行的进程：web 和 runner（在
  `doctor.compose_services` 里时）要求报告里的主机名是运行中容器 id 的开头，且报告时间不早于容器启动时间减
  `schedule.yaml doctor.shipped_report_skew_seconds`（默认 2，容忍 Docker 和数据库的时钟差）；ai-worker（`ai.yaml execution: host` 时）要求报告比
  `host_worker.offline_after_seconds` 新，且 PID 等于 launchd（`launchctl print`）或 systemd（`systemctl --user show -p MainPID`）给出的服务 PID。服务管理器
  给不出 PID 时，报告无法核对。ai-worker 的报告还必须来自本检出目录的发布目录（`<检出目录>/data/releases/ai-worker/<提交>/config`），而且那个提交就是检出目录的 HEAD：
  worker 不在 `data/releases/ai-worker/` 下运行（由发布目录之前的版本安装），或者来自别的提交（只回滚了 worker，或者部署在 ai-worker 那一步之前停下），都是带专门提示的警告。凡是无法确认的都是警告，并逐个列出进程；没有失败。连不上数据库时跳过。项目里运行中的容器在
  `/app/config`（或它下面）有挂载时，这项检查也会告警：挂载会挡住镜像里的默认配置，通常是出厂配置进镜像之前的 `compose.override.yaml`；去掉挂载再部署。

刚部署或重启后，容器的报告可能晚到：等一分钟再运行 doctor。ai-worker 则看 `aiworker.heartbeat` 是否说当前进程还没确认在工作；如果一直缺报告，到 `data/logs/ai-worker.out.log` 里找 "could not report the shipped config"。

ai-worker 的发布目录和切换由 `schedule.yaml` 里的四个键控制。出厂文件里都没有；只有要改时才加到 `data/config/schedule.yaml`（发布目录之前的版本不认识它们，见 [upgrade.zh.md](upgrade.zh.md#downgrade-pre-release-dir)）：

| 键 | 默认 | 含义 |
|---|---|---|
| `deploy.ai_worker_releases_keep` | 3 | 切换后保留的发布目录个数，含当前安装的和上一个（至少 2） |
| `deploy.ai_worker_stop_timeout_seconds` | 60 | worker 的 launchd `ExitTimeOut` / systemd `TimeoutStopSec`（至少 10） |
| `deploy.ai_worker_swap_timeout_seconds` | 120 | 切换中每一段等待的上限（至少停止超时 + 10），也是第 11 步等待的上限（`--settle` 可覆盖） |
| `doctor.shipped_report_skew_seconds` | 2 | `config.shipped` 核对容器报告时容许的 Docker 与数据库时钟差 |

细节见 [deploy.zh.md](deploy.zh.md)《ai-worker 从发布目录运行》。

## 公司筛选与公司总览（`ui.yaml`）

| 键 | 默认 | 含义 |
|---|---|---|
| `filters.company_options_max` | 500 | `/jobs` 公司筛选最多加载多少家（岗位最多的那些）；1 到 5000 |
| `filters.company_options_visible` | 50 | 下拉里不输入搜索词时显示多少家；1 到 5000 |
| `companies.page_size` | 50 | `/companies` 每页行数；1 到 500 |

这些键都可以不写（用默认值），不写的文件不用迁移；整个 `companies` 段也可以省略。公司总览的每页行数在 YAML 或高级编辑器中修改。

回退到没有公司筛选的版本：`interests.yaml` 的视图和 `ui.yaml` 都是严格模式，旧版本读到新键会拒绝整个文件（推送步骤也读不了 `interests.yaml`）。切换前：

1. 停写：`docker compose -p job-radar stop web runner`，等正在跑的处理轮结束。
2. 备份 `data/config/interests.yaml` 和 `data/config/ui.yaml`。
3. 删掉 `interests.yaml` 里所有视图的 `company:` 键。
4. 删掉你的 `ui.yaml` 里的 `filters.company_options_max` 和 `filters.company_options_visible`；并把整个 `companies:` 段删掉，即使你没写过它（在设置里保存时会连同默认值写回；只留下 `companies: {}` 一样会被拒绝）。
5. 用旧版本校验两份文件（在旧镜像里跑 `pnpm config:check` 或 `pnpm run doctor`）。
6. 切换到旧镜像，启动服务。

只回退公司总览（回到有公司筛选、但没有 `/companies` 的版本）：做第 1、2、5、6 步，中间把你的 `ui.yaml` 里整个 `companies:` 段删掉；视图和 `filters.*` 键保留。

出厂的 `ui.yaml` 随镜像，回退后自动是旧版。

## 关注岗位复查（`pipeline.yaml` + `ui.yaml`）

维护步骤会复查收藏和跟进中岗位的原帖页面（见 usage.zh.md"已关闭的岗位"）。相关的键在两个文件里；关注岗位复查的两段都可以缺省（旧文件），缺省时用下面的默认值。表中也列出了可能已关闭和长期未见的有效岗位共用的链接检查设置。

| 文件 | 键 | 默认 | 含义 |
|---|---|---|---|
| `pipeline.yaml`（shipped） | `lifecycle.possibly_closed_after_days` | 7 | 连续未见这么多天，且每个来源通道在到期后都有成功运行，才标为可能已关闭 |
| | `lifecycle.dormant_after_days` | 30 | 可能已关闭满这么多天后休眠；整数 0–3650。0 为关闭，下一次 maintenance 清扫时唤醒已有休眠岗位。可选，缺省时由 schema 提供默认值；出厂文件只含注释 |
| | `lifecycle.unseen_link_check_after_days` | 14 | 有效岗位连续未见这么多天就直接兜底检查链接，不依赖通道运行记录；0 为关闭。可选，缺省时由 schema 提供默认值 |
| | `lifecycle.unseen_link_check_interval_days` | 7 | 同一岗位两次兜底检查的最少间隔天数。可选，缺省时由 schema 提供默认值 |
| | `lifecycle.max_link_checks_per_cycle` | 20 | 可能已关闭和长期未见的有效岗位共用的每轮链接检查上限 |
| | `lifecycle.link_check_timeout_ms` | 10000 | 两类链接检查每次请求的超时毫秒数 |
| | `lifecycle.watch_recheck.interval_hours` | 72 | 同一个关注岗位最多每这么多小时复查一次 |
| | `lifecycle.watch_recheck.max_per_cycle` | 10 | 每轮最多复查几个岗位 |
| | `lifecycle.watch_recheck.per_host_min_interval_ms` | 3000 | 对同一网站两次请求的最小间隔（含 robots.txt） |
| | `lifecycle.watch_recheck.timeout_ms` | 10000 | 单次请求超时 |
| | `lifecycle.watch_recheck.max_body_bytes` | 1048576 | 页面最多读这么多字节，其余不下载 |
| | `lifecycle.watch_recheck.user_agent` | `JobRadar/2 (self-hosted job tracker; link check)` | 关注岗位复查，以及可能已关闭和长期未见的有效岗位的普通链接检查都带它；第一个词是 robots.txt 里匹配的产品名 |
| `ui.yaml`（user） | `job_checks.closed_recheck.enabled` | `true` | 关掉后不再复查关注岗位（可能已关闭和长期未见的有效岗位的普通链接检查照常） |
| | `job_checks.closed_recheck.extra_phrases` | `[]` | 你自己的短语（正则，不区分大小写），与市场包的 `closed_posting.phrases` 合并。只接受安全的子集：文字、字符类、多选 `(a\|b)`、`\b`、可选部分 `?`（最多 8 个）和最多 5 次的 `{n,m}`，长度不超过 200；不允许 `*`、`+`、`{n,}` 和反向引用。写错或不安全的正则 `pnpm config:check` 会报出路径。只搜页面可见文字的前 200,000 个字符，每页最多 250 毫秒（超时的页面记为"未查"） |

`ui.yaml` 这一段在 YAML 或高级编辑器里改（没有表单）。旧版本不认识它：回退前先删掉。

休眠键只有 schema 默认值，无需升级配置版本或迁移文件，`config:migrate --to-full` 不会把它写进用户文件。
回退前，如果手动在用户 `pipeline.yaml` 写过 `lifecycle.dormant_after_days`，请先移除；旧版 strict schema 不接受它。
数据库迁移保留即可，旧代码忽略可空标记，休眠岗位重新可见；再升级时会清扫遗留标记并恢复保护。


## 幽灵岗位检查（`pipeline.yaml` + `ui.yaml`）

招聘帖背后可能没有真实空缺的迹象（见 [ghost-jobs.zh.md](ghost-jobs.zh.md)）。默认关闭；两块都可以没有，没有时用下面的默认值。
说法写在市场包里（`rules.yaml` 的 `ghost`，见 [market-packs.zh.md](market-packs.zh.md#幽灵岗位说法)）。

| 文件 | 键 | 默认 | 含义 |
|---|---|---|---|
| `pipeline.yaml`（随产品提供） | `job_checks.ghost.per_cycle_limit` | 2000 | 每轮最多检查的岗位数 |
| | `job_checks.ghost.levels.watch` / `.likely` | 3 / 5 | "留意" / "疑似幽灵"的分数线（1–50，watch ≤ likely）；"疑似"还要有一个和时间、篇幅无关的原因 |
| | `job_checks.ghost.long_open.tiers` | `[{days: 90, points: 1}, {days: 180, points: 2}]` | 从可信发布日期算起挂的天数和分值（1–10 档，天数递增 1–3650，分值 0–10） |
| | `job_checks.ghost.long_open.first_seen_max_points` | 1 | 只知道首次见到的日期时最多给几分（0–10） |
| | `job_checks.ghost.repost_label.points` | 1 | 来源标注"重新发布"（0–10） |
| | `job_checks.ghost.reposted.min_gap_days` / `.points` | 30 / 2 | 同一来源在同一地点以新编号重挂，至少相隔这么多天（1–3650 / 0–10） |
| | `job_checks.ghost.evergreen_wording.points` | 2 | JD 写明是人才库 / 常年招聘（0–10） |
| | `job_checks.ghost.thin_description.min_words` / `.points` | 120 / 1 | 全文 JD 比这短，或没有职责段落（0–5000 / 0–10） |
| | `job_checks.ghost.thin_description.infer_from_headings` | `true` | 没有当前 JD 拆解时，由职责标题判断长 JD 有没有职责段落。`false`：不看标题，只有短 JD 才算（有当前拆解时仍以拆解为准，职责列表为空也算） |
| | `job_checks.ghost.<信号>.enabled` | `true` | 每个信号都可以单独关掉 |
| | `job_checks.ghost.quote_max_chars` | 280 | 引文最长字数（40–2000） |
| | `job_checks.ghost.negation_words_before` / `_after` | 6 / 5 | 人才库说法前后查否定词的词数（0–20）；`negation_after: clause` 的市场包在说法后一直找到分句结束 |
| | `job_checks.ghost.heading_max_chars` | 60 | 当作标题、和下一行合读的最长行（10–200） |
| | `job_checks.ghost.question_tag_max_words` | 6 | 陈述句后面跟的邀请最多几个词时仍算陈述句（"We are always hiring – want to join?"；1–20）；邀请说法是市场包的 `question_tag`（[market-packs.zh.md](market-packs.zh.md#幽灵岗位说法)） |
| `ui.yaml`（用户） | `job_checks.ghost.enabled` | `false` | 打开：每轮检查岗位，页面显示标记和筛选 |
| | `job_checks.ghost.trusted_companies` | `[]` | 从不标记的公司名（按规范化的名字匹配，不看公司形式，别名生效）；加进来后标记立刻消失，已关闭的岗位也一样 |

旧版本不认 `ui.yaml` 里的 `job_checks.ghost`：回滚前删掉。

## 签证检查（`pipeline.yaml` + `ui.yaml`）

JD 里关于签证赞助的说法（见 [visa-sponsorship.zh.md](visa-sponsorship.zh.md)）。两块都可以没有，没有时用下面的默认值。
说法写在市场包里（`rules.yaml` 的 `visa`，见 [market-packs.zh.md](market-packs.zh.md#签证说法)）。

| 文件 | 键 | 默认 | 含义 |
|---|---|---|---|
| `pipeline.yaml`（随产品提供） | `job_checks.visa.per_cycle_limit` | 2000 | 每轮最多检查的岗位数 |
| | `job_checks.visa.max_quotes` | 3 | 每个岗位保留的引文数（1–10） |
| | `job_checks.visa.quote_max_chars` | 280 | 引文最长字数（40–2000）；句子更长时围绕关键说法截取 |
| | `job_checks.visa.negation_words_before` | 6 | "提供"类说法前面查否定词的词数（0–20） |
| | `job_checks.visa.negation_words_after` | 5 | 说法后面、到分句结束为止查否定词的词数（0–20） |
| | `job_checks.visa.heading_max_chars` | 60 | 当作标题、和下一行合读的最长行（10–200） |
| `ui.yaml`（用户） | `job_checks.visa.enabled` | `true` | 关掉：什么都不检查，页面也不显示 |
| | `job_checks.visa.badges` | `auto` | 列表徽标和 /jobs 筛选什么时候显示：`auto`（me.yaml `needs_visa_sponsorship` 为 true 时才显示）、`always`、`never` |

旧版本不认 `ui.yaml` 里的 `job_checks.visa`：回滚前删掉。

## 轮次重叠（`schedule.yaml` 的 `skip_if_running`、`partial_cycle_wait`）

同一时间只跑一轮。`skip_if_running: true`（默认）时，定时轮次（早轮、晚轮、周末轮，或启动时的补跑）发现另一轮正在运行，按那一轮覆盖的范围决定：

- 正在运行的那一轮采集全部通道：定时轮次记为跳过（再跑只是重复），摘要里写明是哪一轮。
- 正在运行的那一轮只采部分通道（`/sources` 的“立即采集”、只勾了部分通道的手动轮次、`pnpm cycle:run --channel`）：定时轮次等它结束后再跑，所以 07:00 前不久点一下不会再丢掉早上的整轮采集。最多等 `partial_cycle_wait.max_minutes`，到时锁还被占着就记为跳过。

`pnpm reprocess` 在改动已存事实之前等待同一把锁，并一直持锁到整个重新处理结束。期间采集轮次按相同的跳过 / 等待规则执行。
锁使用独立的数据库连接，按 `RUNNER_HEARTBEAT_SECONDS` 的节奏检查；连接丢失时取消当前工作，并等它真正停止后才返回。
CLI 轮次收到 Ctrl-C 或 SIGTERM 时会取消步骤，把这一轮结束为失败。每个新轮次还会回收崩溃的 CLI 或最终写库失败遗留的未结束记录，
无需重启 runner。

| 键 | 默认 | 含义 |
|---|---|---|
| `partial_cycle_wait.max_minutes` | 60 | 等待只采部分通道的那一轮最多多久；0 = 不等（照旧跳过） |
| `partial_cycle_wait.poll_seconds` | 15 | 等待时每隔多久再试一次 |

出厂文件里没有这一段（只以注释给出）；要改时才加到 `data/config/schedule.yaml`（没写的键用默认值）。定时轮次等待期间，runner 不启动别的手动轮次（其他按钮照常执行），所以连续点几次“立即采集”不会让它一直等下去；它开跑后，排队中被它覆盖的请求记为完成。手动轮次从不等待：runner 一次处理一个请求，等着的请求会挡住其他按钮。正在运行的那一轮已经覆盖了手动请求时（全部通道的定时轮次），请求记为完成，按钮显示那一轮；否则照旧以“另一轮正在运行”失败。启动时的补跑和 `pnpm run doctor`（`cycle.last`）判断有没有错过时段时，只算采了全部通道的轮次。等待中的轮次还没有记录行：这时部署排空 runner 不会等它（重启后由补跑执行）；等待超过 `doctor.cycle_grace_minutes` 时，`cycle.last` 在它开跑前会报这个时段错过了。LinkedIn 来源组成级联，采全部通道的一轮只用级联里第一个可用的来源，所以级联里靠后的来源的“立即采集”不会被它覆盖。

回退到不认识 `partial_cycle_wait` 的版本之前，先删掉 `data/config/schedule.yaml` 里的这一段：旧版本拒绝未知的键。

## 日志级别（`schedule.yaml` 的 `logging.level`、`JOB_RADAR_LOG_LEVEL`）

网页、runner、ai-worker 和 `pnpm cycle:run` 默认按 `info` 记日志。`debug` 会多记诊断记录：AI 提供方的检查、路由跳过的提供方、HTTP 重试、别的聊天发来的 Telegram 消息。

| 位置 | 取值 | 含义 |
|---|---|---|
| `.env` 里的 `JOB_RADAR_LOG_LEVEL` | `debug`、`info`、`warn`、`error`（不分大小写） | 优先于配置。空值 = 没设。其他值当作没设（用配置里的级别），并在日志里提示一次，不显示这个值 |
| `schedule.yaml` 的 `logging.level` | 同上，默认 `info` | 环境变量没设时使用。出厂文件里没有这个键：不加就用默认值 |

- **加到你现有的 `data/config/schedule.yaml` 里**，例如 `logging:` 下面写 `level: debug`。用户文件整份替换出厂文件（见“读哪一份”），只有一个 `logging` 段的 `schedule.yaml` 是非法的。
- **改配置文件不需要重启。** runner 和 ai-worker 经监视器跟随（Docker 绑定挂载上文件事件不可靠，由轮询接手）；网页按需检查，最多每个 `JOB_RADAR_CONFIG_POLL_MS` 一次。`JOB_RADAR_CONFIG_POLL_MS=0` 时网页不做按需检查：外部的改动要等重启，或者网页自己写这个文件（在设置页保存）后才生效。每个进程最多每个间隔重新取一次级别（间隔为 `0` 时按 5 秒），所以重新加载后几秒内生效。
- **`schedule.yaml` 改坏了**：沿用上一份合法的级别，直到进程重启（加载器保留上一份合法的文件）。进程启动时文件就是坏的：按 `info` 记日志，提示一次，文件改好后立即采用。
- **改了 `.env`**：容器要重建，`docker compose up -d`（`restart` 沿用旧的环境变量），ai-worker 要重启（它启动时读 `.env`）。只在 shell 里设的变量到不了容器。

回退到不认识 `logging.level` 的版本之前，先删掉 `data/config/schedule.yaml` 里的 `logging` 段：旧版本拒绝未知的键。

## 备份

每一份备份，不管是 runner 每天做的（`backup.config_archive`，默认开）还是 `scripts/ops/backup.sh` 做的，都会在数据库 dump 旁边留一份 `….config.tgz`（`data/config` + `data/profile`，不含 `.backup/` 和登录密钥 `.web-session-secret`）。`schedule.yaml` 的 `backup` 段还有 `pre_migrate`（数据库迁移前先备份）、`keep_system`（每一类安全备份保留几份）和 `keep_old_databases`（恢复时被替换的旧库保留几个）。`.env` 和 `.auth/` 不在任何备份里。见 [`backup-restore.zh.md`](backup-restore.zh.md)，包括"恢复配置"。

`scripts/ops/backup.sh` 和 `restore.sh` 通过应用的加载器读 `schedule.yaml`。加载器跑不起来（没有 node、没有 `node_modules`）或者文件不合法时，由一个严格的 shell 读取器读 `timezone`（`restore.sh` 还读 `backup.max_age_hours`）。`timezone` 请写成 `地区/城市`（`Europe/Berlin`、`America/Argentina/Buenos_Aires`）或 `UTC`。shell 读取器比加载器严格：加载器接受的一段名字，例如 `Japan`、`GMT`、`EST5EDT`，在它看来不明确，`backup.sh` 这时用 UTC 给这份备份命名（并警告）。只影响这条退路；runner 和加载器照旧读这些名字。

## 从单目录切换

旧版本的线上配置就是 git 里的 `config/`。切换代码前先单独保留这份线上目录；停掉旧消费者后，用 `pnpm config:init --from <保留的旧配置目录>` 导入，再让部署补缺。已有安装现在在第 4 步先预览和校验再冻结，第 11 步 `config-write` 排除旧 worker 后才补缺和写迁移。之后网页只写 `data/config/`，`config/` 存放产品默认值。详见 [`deploy.zh.md`](deploy.zh.md) 第 4、5 节与 [upgrade.zh.md](upgrade.zh.md)。

### 升级写入保护

来源开关与看板、发现的看板候选、搜索城市同步、工作流设置、兴趣编辑，以及设置向导的配置和进度，都在文件锁与跨进程目录锁内读取当前值，同时修改不同字段会保留彼此的更新。读取前先检查升级冻结；冻结或锁忙会显示对应提示。薪资设置表单与其他设置表单、来源导入一样，会拒绝覆盖预览后已被改动的文件。向导的市场与目标步骤只合并各自负责的偏好字段，画像历史在释放目录锁后记录。

`pnpm ops:freeze --target <commit>` 冻结配置与 profile 写入；`pnpm ops:unfreeze` 在同一套跨进程写锁内删除标记，并提示先运行 `pnpm config:init`，再运行 `pnpm config:migrate --write`。先确认没有旧消费者再手工解除。第 8 步启动容器之前失败或中断，部署只自动解除本次全新创建的冻结；接管的标记必须等 `config-write` 通过消费者检查或用户运行 `ops:unfreeze` 才会解除。尝试 `up` 后失败或中断则保留所有标记。认识冻结协议的 web 在冻结期间拒绝保存；首次升级的旧 web 到第 8 步之前仍写无害的旧格式文件。doctor 用 `config.freeze` 检查遗留标记和超过过期阈值的写锁及 guard 持有者。遗留锁在下次写入时自动接管；若保存持续失败，确认持有者不再写入后删除锁文件或 guard 内的持有者文件。`pnpm config:migrate --json` 只读返回待迁移和问题数量。锁的时限由 `schedule.yaml` 的 `deploy.config_write_lock_stale_seconds`、`config_write_lock_wait_seconds`、`config_write_lock_retry_ms` 配置（默认 300 秒、10 秒、50 毫秒）。同主机持有者记录随机进程 ID 与进程启动时间；PID 重用或 token 已遗弃时立即接管，活跃持有者不接管。其他主机或命名空间仅在超过过期阈值后接管，最终提交再次核对锁的所有权。恢复与长驻进程重启见 [upgrade.zh.md](upgrade.zh.md#升级期间的设置)。

## 当前展示分数（`current-scores.yaml`）

此出厂文件控制可重建的分数投影，用户同名文件整体覆盖出厂配置。
`backfill.lock_timeout_ms` 限制迁移等待 SHARE 锁的时间（100–60000 毫秒），
`backfill.statement_timeout_ms` 限制回填语句的执行时间（1000–600000 毫秒）。两者分别按语句生效，不是整次迁移的总超时。
`refresh.lateral_max_jobs` 决定小批刷新使用索引 LATERAL 查询，较大批次使用按岗位限定的 CTE（1–100000 个岗位）。
所有键均必填；此文件不影响硬过滤指纹。

## 关注公司查询配置

`search.yaml` 新增 `watched_company_queries`：`enabled` 默认 `true`、`max_per_cycle` 默认每单元 3 条、`min_interval_hours` 默认 24、`max_results` 默认每条 25（仍受通道上限约束）。旧用户文件缺整个块或内部键时由 schema 补默认值，显式 `false` 生效。没有数据库迁移。

`sources.yaml` 中支持的通道默认 `company_queries: true`：`linkedin.session`、`linkedin.guest`、`linkedin.brightdata`、`linkedin.apify`、`sources.arbeitsagentur`、`sources.indeed`、`sources.jobspy_google`、`sources.jsearch`、`sources.stepstone`、`sources.xing`。可在“来源 → 来源清单 → 详情”或“设置 → 通道”编辑。它允许把关注公司名外发，见[隐私](privacy.zh.md)及[查询规则与容量](sources.zh.md#关注公司查询)。“设置 → 搜索”可编辑总开关、每轮上限、间隔和结果上限。

**回退：**只需停用时设 `watched_company_queries.enabled: false`。启动旧代码前，从用户 `data/config/search.yaml` 删除整个 `watched_company_queries` 块，从 `data/config/sources.yaml` 删除所有 `company_queries` 键（包括设置保存时写入的不支持通道块）；再用旧版 `pnpm config:check` 验证。旧版严格 schema 会拒绝新键。保留数据库历史和原始岗位。
