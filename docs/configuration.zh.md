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
| `user` | schedule、search、sources、ai、notify、interests、ui、breakdown、resume、insights、language、setup、salary（[salary.zh.md](salary.zh.md)）、mcp（[mcp.zh.md](mcp.zh.md)） | 从默认目录复制到用户目录，之后归你 | 不会自动改你的文件；格式变化由迁移（`config_version`）带过去 |
| `shipped` | models（模型目录和价格）、pipeline（解析规则、城市和技能表）、signal-presets（`/interests`“新增类别”对话框的预设，见 [signals.zh.md](signals.zh.md#添加你自己的兴趣点)） | 不复制，一直读默认目录的 | 跟着产品更新 |

产品升级新增的 `user` 文件会在下次启动时从默认目录复制过来；如果用户目录里本来就有配置（老安装），可以改为写入保持原有行为的版本
（`language.yaml`：中文，见 [languages.zh.md](languages.zh.md)）。初始化向导用同一个"老安装"判断。

想改 `shipped` 文件：把它复制到用户目录再改（整份覆盖）。代价是产品以后对这个文件的更新不再生效：`pnpm config:check` 和 doctor 的 `config.layers` 会一直提示"你覆盖了 models.yaml"。想重新跟随产品：删掉用户目录里那份。

市场包（`config/packs/<id>/`：国家、城市、本地语言规则）也按 `shipped` 处理：`data/config/packs/<id>/` 里的副本整包替换发布的那份。见 [market-packs.zh.md](market-packs.zh.md)。

画像文件 `me.yaml` 和 `preferences.yaml` 在 `data/profile/` 里，在 `/me` 页编辑。`preferences.yaml` 里可选的 `deal_breakers` 列表
（在任何 AI 调用之前否决岗位的规则）见 [deal-breakers.zh.md](deal-breakers.zh.md)；它的上限在 `pipeline.yaml: filter.deal_breakers`。

## 命令

```bash
pnpm config:init                  # 建用户目录，复制缺的 user 文件和画像模板；已有的不动（可重复运行）
pnpm config:init --from <目录>     # 从别的目录复制（旧安装迁移用），并复制与默认内容不同的 shipped 文件
pnpm config:migrate               # 列出要迁移的文件和 diff，不写
pnpm config:migrate --write       # 迁移：先把要改的原文件备份到 data/config/.backup/<时间>/，再写
pnpm config:check                 # 校验两层（默认目录的文件即使被覆盖也要合法），写出每个文件读的是哪层和出厂配置标识
pnpm config:example               # 列出示例配置；`pnpm config:example <id> [--dry-run]` 套用其中一个（见下文）
```

web 和 runner 启动时也会自动做一次 `config:init`（缺什么补什么；runner 在容器里对用户目录只读，目录已满时不需要写）；`scripts/ops/deploy.sh` 第 4 步依次运行 `config:init` → `config:migrate --write` → `config:check`。

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
| `ai.yaml` | `providers.*.command`（`claude` / `codex` 可执行文件）、`providers.*.base_url`（DeepSeek、MiMo）、`providers.codex_cli.config_overrides`、`providers.codex_cli.disable_features`、`providers.codex_cli.trim_context` |
| `notify.yaml` | `telegram.api_base_url` |
| `sources.yaml` | 所有 `base_url`、`api_base_url`、`eu_api_base_url`，`jobspy.url`，`jobspy.proxies`，`sources.gmail.host` / `port` / `secure`，`linkedin.session.site.auth_file`，`linkedin.apify.actor_id` |
| `resume.yaml` | `claude_command`、`claude_args`、`resume_kit_path`、`master_resume_path`、`pdf_dir`、`jd_export_dir`、`jd_export_host_dir` |
| `ui.yaml` | `web_access` 下的全部键（登录限制，见[网页访问](#网页访问可选口令监听地址和端口)） |

- web 保存时，如果受保护键的值既不同于文件里的值，**也**不同于出厂默认值，就拒绝保存。写回文件里已有的值或出厂默认值（例如"恢复默认"，或旧文件还没有的键）是允许的。
- 设置表单里这些字段是只读的，带锁定说明；高级编辑器在文本上方列出它们，改动会在对应行标成问题（"受保护的键"），保存按钮不可用。
- 如果确实要让 web 改（例如只有你自己能访问 web 的机器），在 `.env` 里设 `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` 并重启 web（`docker compose up -d web`）。表单里的字段仍显示为锁定，请用高级编辑器改。
- 清单在 `src/lib/config/protected-keys.ts`。

### 使用时再检查一次

上面的锁定是 web 这一侧。ai-worker 和 runner 也不信任文件（它可能是手动改的，或者设了 `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1`），所以有几个值在使用的地方再检查一次，不管文件里写了什么（出厂值总能通过）：

- `ai.yaml providers.claude_cli.command` / `providers.codex_cli.command` 必须是 `claude` / `codex` 这个可执行文件（裸名字或绝对路径）；`providers.codex_cli.config_overrides` 只保留设为 `false` 的裁剪上下文开关；不管 `disable_features` 和 `trim_context` 怎么写，codex 的工具限制始终生效。
- 接收凭据的服务（DeepSeek、MiMo、Telegram、JSearch、Tavily、Brave、Apify）的 `base_url` / `api_base_url` 必须指向厂商自己的主机，`sources.gmail` 必须是带 TLS 的 `imap.gmail.com:993`，除非 `.env` 里设了 `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1`。带凭据的请求不跟随重定向。
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
| `deploy.ai_worker_swap_timeout_seconds` | 120 | 切换中每一段等待的上限（至少停止超时 + 10），也是第 12 步等待的上限（`--settle` 可覆盖） |
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
| | `lifecycle.unseen_link_check_after_days` | 14 | 有效岗位连续未见这么多天就直接兜底检查链接，不依赖通道运行记录；0 为关闭。可选，缺省时由 schema 提供默认值 |
| | `lifecycle.unseen_link_check_interval_days` | 7 | 同一岗位两次兜底检查的最少间隔天数。可选，缺省时由 schema 提供默认值 |
| | `lifecycle.max_link_checks_per_cycle` | 20 | 可能已关闭和长期未见的有效岗位共用的每轮链接检查上限 |
| | `lifecycle.link_check_timeout_ms` | 10000 | 两类链接检查每次请求的超时毫秒数 |
| | `lifecycle.watch_recheck.interval_hours` | 72 | 同一个关注岗位最多每这么多小时复查一次 |
| | `lifecycle.watch_recheck.max_per_cycle` | 10 | 每轮最多复查几个岗位 |
| | `lifecycle.watch_recheck.per_host_min_interval_ms` | 3000 | 对同一网站两次请求的最小间隔（含 robots.txt） |
| | `lifecycle.watch_recheck.timeout_ms` | 10000 | 单次请求超时 |
| | `lifecycle.watch_recheck.max_body_bytes` | 1048576 | 页面最多读这么多字节，其余不下载 |
| | `lifecycle.watch_recheck.user_agent` | `JobRadar/2 (self-hosted job tracker; link check)` | 复查和"可能已关闭"链接检查都带它；第一个词是 robots.txt 里匹配的产品名 |
| `ui.yaml`（user） | `job_checks.closed_recheck.enabled` | `true` | 关掉后不再复查（"可能已关闭"的链接检查照常） |
| | `job_checks.closed_recheck.extra_phrases` | `[]` | 你自己的短语（正则，不区分大小写），与市场包的 `closed_posting.phrases` 合并。只接受安全的子集：文字、字符类、多选 `(a\|b)`、`\b`、可选部分 `?`（最多 8 个）和最多 5 次的 `{n,m}`，长度不超过 200；不允许 `*`、`+`、`{n,}` 和反向引用。写错或不安全的正则 `pnpm config:check` 会报出路径。只搜页面可见文字的前 200,000 个字符，每页最多 250 毫秒（超时的页面记为"未查"） |

`ui.yaml` 这一段在 YAML 或高级编辑器里改（没有表单）。旧版本不认识它：回退前先删掉。

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

## 从单目录切换

旧版本的线上配置就是 git 里的 `config/`。升级到分层配置时，`scripts/ops/deploy.sh` 第 4 步看到 `data/config/` 是空的，`pnpm config:init` 就把当时 `config/` 里的全部 user 文件复制过去（此时默认配置就是旧线上配置，和 `pnpm config:init --from config` 结果相同）。之后网页只写 `data/config/`，`config/` 回到"产品默认值"的角色，不会再让 checkout 变脏。详见 [`deploy.zh.md`](deploy.zh.md) 第 4、5 节。
