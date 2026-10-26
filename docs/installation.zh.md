# 安装

[English](installation.md) | [中文](installation.zh.md)

这份指南带你从一个空目录走到 Job Radar 跑起来：看板、AI 打分，以及（如果你需要）Telegram 推送和手机访问。除非特别说明，
下面的命令都在项目目录里执行（也就是有 `package.json` 和 `compose.yaml` 的那个目录）。

第 1、3、5、6 步是主干；标了“可选”的都可以以后再做。

## 开始之前

### 需要什么

| | 版本 | 用来做什么 |
|---|---|---|
| Docker（Compose 2.24 以上） | macOS 用 Docker Desktop；Linux 用 Docker Engine 加 compose 插件。Compose 要 2.24 或更新（compose 文件把 `.env` 设成可选，旧版本不认） | 运行看板、runner、抓取 sidecar 和数据库 |
| Node.js | 22.23.4 或更新的 22.x（项目限定 `>=22.23.4 <23`；AI worker 的发布目录守卫需要这些版本的同步模块 hook） | 辅助命令，以及跑在你机器上的 AI worker |
| pnpm | 必须是 `package.json` 里写的版本（`packageManager`，目前是 11.15.1） | 给辅助命令装依赖；建 AI worker 发布目录时版本不对会拒绝 |
| git | 较新的版本即可 | 获取代码，以后升级 |
| 磁盘空间 | 几 GB | 镜像（runner 镜像里带一个无界面浏览器）和数据库。每个 AI worker 发布目录（`data/releases/ai-worker/<提交>/`，由 `scripts/ops/prepare-release.sh` 建）按 `du` 算约 580 MB；APFS 上其中的文件是 pnpm store 的克隆，每份实际只多占约 60 MB |

看看你已经有什么：

```bash
docker compose version
node --version      # v22.23.4 或更新，低于 v23
pnpm --version      # package.json 里 packageManager 的版本
git --version
```

还没有 pnpm，或者版本不对？Node 22 下执行 `corepack enable`，就会用 `package.json` 里固定的版本；`npm install -g pnpm@<那个版本>` 也行。

以后再准备也可以的：

- **AI**：在这台机器上登录好的 `claude`（Claude Code）或 `codex`（Codex CLI）订阅，或者 Anthropic、DeepSeek、MiMo 的
  API key。没有 AI，Job Radar 照样采集、去重、过滤、展示岗位。
- **Telegram**：推送到手机。
- **Tailscale**：在手机上打开看板。

### macOS、Linux、Windows

- **macOS** 是 Job Radar 每天实际在跑的平台。想让 Mac 无人值守（登录时启动 Docker、断电后自动开机、外接硬盘），再看
  [host-setup.zh.md](host-setup.zh.md)。
- **Linux** 上所有部分都一样能跑；CI 里会在全新的 Ubuntu 上从零装一遍。区别有两处：容器以你的用户身份运行（`PUID` / `PGID`，第 3 步），
  辅助脚本把 AI worker 装成 systemd 用户单元而不是 launchd 服务（第 5 步）。Linux 主机清单见
  [host-setup.zh.md 第 10 节](host-setup.zh.md#10-linux)。
- **Windows（WSL2）**：全部在 WSL2 里跑。把仓库克隆到 Linux 文件系统里（比如 `~/job-radar`，不要放在 `/mnt/c` 下，那里绑定挂载慢、
  权限也不一样），在 Docker Desktop 里为这个发行版打开 WSL 集成，在 WSL 里装 Node、pnpm 和 `claude` / `codex` 命令行。步骤和 Linux 一样。
  `pnpm ai-worker` 也在 WSL 里跑（放在 tmux 里，或者在支持 systemd 的 WSL 里做成 systemd 用户服务）。在 Windows 的浏览器里打开
  <http://127.0.0.1:3000>。WSL2 维护者没有测试过，欢迎反馈。
- **让 AI worker 常驻**：`scripts/ops/install-ai-worker.sh` 在 macOS 上装成 launchd 代理，在 Linux 上装成 systemd 用户单元
  （`job-radar-ai-worker.service`）。两者都没有的话，用你自己的进程管理工具跑 `pnpm ai-worker`（第 5 步）。
- **一人一实例。** 同一台机器上的第二套要用自己的项目名、卷名和端口：见 [multiple-instances.zh.md](multiple-instances.zh.md)。

## 1. 获取代码

```bash
git clone https://github.com/Joevonlong/job-radar.git
cd job-radar
git checkout v2.0.1          # 推荐：停在发布版本上（从新到旧列出：git tag --list 'v*' --sort=-v:refname）
```

`main` 是开发分支，两个版本之间随时会变。停在发布标签上，升级才可预期（见[升级](#升级)）。切到标签后 git 会提示
“detached HEAD”，这是正常的。

## 2. 可选：创建 `.env`

每个变量都有能用的本地默认值，这一步可以先跳过。

```bash
cp .env.example .env
```

要放密钥的时候才需要 `.env`：Telegram bot token、AI 的 API key、付费或需要 key 的来源（JSearch、Tavily、Bright Data、Apify、Monid、
Gmail）、换一个数据库密码、给看板加额外的主机名。每个变量在 `.env.example` 里都有说明。`.env` 被 git 忽略：不要提交它，
也不要把内容贴到任何地方。

| 来源或功能 | 变量 | 说明 |
|---|---|---|
| Arbeitsagentur、Arbeitnow、公司招聘页 | 不需要 | [sources.zh.md](sources.zh.md) |
| Indeed、StepStone、XING、LinkedIn 游客搜索 | 不需要；新安装时关闭，打开时要你确认服务条款风险 | [sources.zh.md](sources.zh.md#抓取) |
| 用你自己登录态的 LinkedIn | 不需要：用 `pnpm auth:linkedin` 登录一次（默认关闭，先看风险说明） | [linkedin-session.zh.md](linkedin-session.zh.md) |
| 经 Bright Data / Apify / Monid 的 LinkedIn（付费） | `BRIGHT_DATA_API_KEY` / `APIFY_TOKEN` / `MONID_API_KEY` | [brightdata.zh.md](brightdata.zh.md)、[apify.zh.md](apify.zh.md)、[monid.zh.md](monid.zh.md) |
| 经 JSearch 的 Google Jobs | `JSEARCH_API_KEY` | [jsearch.zh.md](jsearch.zh.md) |
| Gmail 职位提醒邮件 | `GMAIL_USER`、`GMAIL_APP_PASSWORD` | [gmail-alerts.zh.md](gmail-alerts.zh.md) |
| 发现新的公司招聘页 | `TAVILY_API_KEY` | [tavily.zh.md](tavily.zh.md) |
| Telegram 推送 | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | 下面第 7 步 |
| 通过 API 用 AI | `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、`MIMO_API_KEY` | 下面第 4 步 |
| 看板口令 | `JOB_RADAR_WEB_PASSWORD_HASH`（由 `pnpm web:password` 生成） | 下面第 8 步 |
| Linux：容器以哪个用户运行 | `PUID`、`PGID` | 下面第 3 步 |

改完 `.env` 之后执行 `docker compose up -d` 让容器读到新值；改了 AI key 或 Telegram token 的话，还要重启 AI worker（第 5 步）。

## 3. 启动服务

在 Linux 上，先告诉容器这个项目目录属于哪个用户（macOS 不需要，Docker Desktop 会自己处理归属）：

```bash
sed -i.bak -e "s/^PUID=.*/PUID=$(id -u)/" -e "s/^PGID=.*/PGID=$(id -g)/" .env && rm .env.bak      # 仅 Linux
mkdir -p data/config data/profile data/backups data/exports data/logs .auth
```

web 和 runner 会把你的设置、备份和导出写进 `data/`。它们以 `PUID:PGID`（默认 `1000:1000`）运行，所以在 Linux 上这些目录必须归这个 id 所有；
自己先建好目录，就不会让 Docker 以 root 身份去建。

然后启动全部服务：

```bash
docker compose up -d --build      # 等同于 pnpm stack:up
docker compose ps
```

构建镜像需要访问 npm registry、Docker Hub 和微软的镜像仓库（基础镜像和 Dockerfile 前端镜像）、Ubuntu 和 PostgreSQL 的
apt 源以及 PyPI。编译 web（包括字体）不需要网络：字体随 npm 包安装，所以屏蔽了 Google 的网络也能构建。

第一次构建要几分钟。之后一两分钟内，`docker compose ps` 里的 `db`、`web`、`runner`、`jobspy` 应该都变成 `healthy`。
Docker 起来以后，这四个服务在重启后都会自己恢复（`restart: unless-stopped`）。

某个服务一直不健康时：

```bash
docker compose logs --tail 100 web       # 或 runner、db、jobspy
```

本文里的名字都是默认值：compose 项目 `job-radar`、数据库卷 `jobradar-pg`、看板端口 3000、数据库的宿主机端口 5433。同一台机器上的
第二套要在第一次启动前换成自己的（`COMPOSE_PROJECT_NAME`、`JOBRADAR_PG_VOLUME`、`JOB_RADAR_WEB_PORT`、`DB_HOST_PORT`），见
[multiple-instances.zh.md](multiple-instances.zh.md)。

## 4. 登录你的 AI（可选，推荐）

在这台机器上你自己的终端里做。CLI 本身怎么安装，看它们各自的官方说明。

| AI | 登录 | 检查 |
|---|---|---|
| Claude（订阅） | 运行 `claude`，输入 `/login`，按提示完成后退出 | `claude auth status` 显示 `loggedIn: true` |
| Codex（订阅） | `codex login` | `codex login status` 显示 Logged in |
| API key | 在 `.env` 里填 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 或 `MIMO_API_KEY`（DeepSeek 和 MiMo 还要在 `ai.yaml` 里设 `enabled: true`） | 第 5 步之后运行 `pnpm ai:probe` |

订阅命令行不按 token 计费；每天的调用上限（默认 codex 200 次、claude 100 次）保护你的额度。API 只有在命令行都用不了时才会用到，
到 `ai.yaml` 里 `monthly_api_budget_usd` 的月预算就停。不要把订阅 token 放进 `.env` 或容器：AI worker 直接用你的命令行登录。
详见 [ai-providers.zh.md](ai-providers.zh.md)。

## 5. 启动 AI worker

AI worker 是跑在你机器上（不在 Docker 里）的一个小 Node 进程。它从数据库里认领所有 AI 请求，用你的命令行登录或 API key 执行，
写回结果，再发 Telegram 推送。

```bash
pnpm install
pnpm ai-worker
```

让它一直开着。最好在向导的 AI 那一步之前就启动，这样向导里的 **Test**（测试）按钮才有回应。worker 没开时，AI 请求只是排队：
`/sources` 上的 AI worker 卡片显示“无响应”，三分钟后 runner 会发一条 Telegram 告警（如果开了 Telegram）。

一个数据库只跑一个 AI worker；第二个会以退出码 3 退出，并提示 `another ai-worker is running against this database`。
只想把队列处理一遍就退出：`pnpm ai-worker --once`。

### 在后台常驻

先把终端里那个停掉（Ctrl-C），再装成登录时启动、崩溃后自动重启的服务。装之前先把服务栈启动起来（`docker compose up -d`，第 3 步）：worker 一启动就要用数据库。同一个脚本两个系统都能用：macOS 上是 launchd 服务，
Linux 上是 systemd 用户单元（`job-radar-ai-worker.service`）。

```bash
scripts/ops/install-ai-worker.sh --dry-run    # 只打印要写的内容，不做任何改动
scripts/ops/install-ai-worker.sh
```

检查一下：

```bash
# macOS
launchctl print gui/$(id -u)/io.jobradar.ai-worker | grep -E "state|pid"   # 应为 state = running
tail -n 20 data/logs/ai-worker.out.log        # 错误在 data/logs/ai-worker.err.log

# Linux
systemctl --user status job-radar-ai-worker.service
journalctl --user -u job-radar-ai-worker.service -n 50     # 启动失败看这里；worker 自己的日志在 data/logs/
loginctl enable-linger "$USER"                # 退出登录后也继续运行（有的系统要 sudo）
```

升级 Node 或挪了 `claude` / `codex` 的位置之后，再运行一次这个脚本。卸载服务：`scripts/ops/uninstall-ai-worker.sh`。

在 Linux 上这个脚本需要 systemd 用户会话：从正常登录的终端运行，不要经 `sudo`、`su` 或 cron。没有用户会话时（容器里、没开 systemd
的 WSL）它会说明原因，什么都不改；这时用你习惯的进程管理方式，比如一个后台 tmux 会话：`tmux new -d -s jobradar-ai 'pnpm ai-worker'`。
细节（包括项目放在外接硬盘时的日志、手动安装用的单元模板）见 [host-setup.zh.md](host-setup.zh.md)（macOS 第 6b 节，Linux 第 10 节）。

## 6. 走一遍设置向导

打开 <http://127.0.0.1:3000>。向导完成之前，每个页面都会跳到向导。

| 步骤 | 你要选的 |
|---|---|
| 语言 | 界面语言、AI 写字用的语言、JD 翻译成的语言 |
| 市场 | 市场包、国家、货币、本地语言、城市、远程范围、时区 |
| 画像 | 给 AI 看的简短介绍、技能和年限、语言和等级、工作年限、签证、城市 |
| 目标 | 职位名称、级别、办公方式、薪资底线、合同类型、要排除的 |
| 来源 | 你所在市场的招聘网站、要加的公司招聘页。抓取网站或用你 LinkedIn 登录的来源默认不勾；勾上时会提示服务条款风险，要你确认 |
| AI | 用哪些命令行和 API、什么顺序、用哪个模型；每个都能测试 |
| Telegram（可选） | 推送开或关、消息语言、发一条测试消息 |
| 回顾 | 每一步做了什么、就绪清单、“现在跑第一轮”、完成 |

“保存并继续”会立刻写进你的配置文件；“跳过”就先留着。密钥和 token 从不在向导里输入：它只显示 `.env` 里哪些变量已经设好。
在你完成向导（或选择“跳过向导”）之前，runner 不跑定时轮次，不会拿占位关键词去采集。


这台机器上没有浏览器？终端里有同样的问题：

```bash
pnpm run setup                 # 全部 8 步；直接回车保留 [方括号] 里的值
pnpm run setup --step ai       # 只做一步
pnpm run setup --status        # 看设置进行到哪了
```

以后想再打开向导：设置 → 手动操作 → “打开设置向导”，或者直接访问 `/setup`。想快点上手？`pnpm config:example` 列出现成的示例配置，
可以叠加到你的配置上（加 `--dry-run` 先看会改什么）。详见 [setup.zh.md](setup.zh.md)、[configuration.zh.md](configuration.zh.md)。

## 7. 可选：Telegram 推送

Telegram 在你设置好之前是关着的。向导里跳过 Telegram 这一步，它就保持关闭；没打开的推送 doctor 也不会报。

1. 在 Telegram 里打开 `@BotFather`，发送 `/newbot`，按提示起名，复制 token（形如 `123456:ABC-...`）。
2. 在项目目录里运行：
   ```bash
   pnpm run setup --step telegram
   ```
   粘贴 token（不显示），按提示给你的 bot 随便发一句话。命令会找到 chat id、发一条测试消息、写入 `.env`（先做备份）、
   问你要不要打开推送，然后重启容器和 AI worker 让它们读到新值。加 `--no-restart` 则只打印重启命令，不替你运行。
3. 检查：设置 → 推送 显示“已连接”，`pnpm run doctor --only telegram` 全是 ✅。

想手动配置（用 `getUpdates` 找 chat id、改 `.env`、重建容器）？见 [telegram.zh.md](telegram.zh.md#手动配置)。

bot 只接受来自你这个 chat id 的消息和按钮；按钮是通过长轮询收回来的，不需要开任何端口。推送和按钮的规则见
[telegram.zh.md](telegram.zh.md)。


## 8. 可选：在手机上打开（Tailscale）

看板只监听 `127.0.0.1:3000`（`JOB_RADAR_WEB_BIND` 和 `JOB_RADAR_WEB_PORT` 的默认值），不对公网暴露任何东西。手机通过 Tailscale
（你自己设备之间的私有网络）访问它。

1. 在这台机器和手机上都装 Tailscale，用同一个账号登录。
2. 在 Tailscale 管理后台（DNS）打开 **MagicDNS** 和 **HTTPS Certificates**。
3. 在这台机器上执行（改过 `JOB_RADAR_WEB_PORT` 的话换成你的端口）：
   ```bash
   tailscale serve --bg 3000
   tailscale serve status      # 打印出 https://<机器名>.<tailnet>.ts.net
   ```
4. 在手机浏览器里打开这个地址。也把它填进 `notify.yaml` 的 `public_base_url`，推送里的链接才能打开岗位页。

不要用 `tailscale funnel`：那会把看板放到公网上（`tailscale serve reset` 可以撤掉 serve 规则）。如果放在别的反向代理后面或用局域网名字访问，
要把主机名加进 `.env` 的 `JOB_RADAR_ALLOWED_HOSTS`，否则看板会返回 `421 Misdirected Request`（见
[configuration.zh.md](configuration.zh.md#哪些主机名能访问-webjob_radar_allowed_hosts)）。

### 别人也能访问时，设一个口令

在这台机器上，看板不用登录。你 tailnet 里的每台设备也都能访问它；所以如果有别人共用你的 tailnet，或者你把它开放到局域网、放到反向代理后面，
先设一个口令：

```bash
pnpm web:password            # 问两遍，打印一行：JOB_RADAR_WEB_PASSWORD_HASH=scrypt:...
# 把这一行贴进 .env，然后：
docker compose up -d web
```

之后别的设备会看到登录页；这台机器上的浏览器照样直接进。没设口令时，只要从别的机器打开看板，每个页面都会显示一条红色警告。要让看板在本机以外也能访问，
就同时设好 `JOB_RADAR_WEB_BIND`（比如 `0.0.0.0`）和口令，否则 doctor 会报错。会话、锁定和其他细节见
[configuration.zh.md](configuration.zh.md#网页访问可选口令监听地址和端口)。

## 9. 全面体检

```bash
pnpm run doctor
```

它逐项检查 Docker、四个服务、数据库、runner 和 AI worker 的心跳、AI 登录、Telegram、Tailscale、备份、磁盘空间、每个已开启的来源
和你的配置，用 ✅ / ⚠️ / ❌ 标出来，每个问题下面写着该怎么做。它只读不写：不调用 AI、不发 Telegram、不花钱。注意写成
`pnpm run doctor`：单写 `pnpm doctor` 是 pnpm 自己的命令。退出码：0 全部 ✅，1 有 ⚠️，2 有 ❌，3 doctor 本身没能运行。

刚装好时有几项会给警告，等你配好就没了：Tailscale 和公开地址（⚠️）；出厂就开着的付费渠道（`linkedin-brightdata`、
`linkedin-apify`、`linkedin-monid`、`tavily`），在你填 key 或关掉之前；上一轮和上次备份，在第一轮、第一次备份之前；worker 在终端里跑而没装成服务时还有
`aiworker.launchd`（在 Linux 上这一项读的是 systemd 用户单元）。LinkedIn 是可选的：一个 LinkedIn 渠道都没设置时，LinkedIn 那一行会这么写，
仍是 ✅。在 Linux 上，`data/` 下有文件不归 `PUID` 所有时，`data.ownership` 会警告。没打开的 Telegram
推送不会报。浏览器里 `/sources` 页显示同样的健康状态，包括 AI worker 卡片。

第一轮可以在向导的回顾步骤里跑，也可以在 设置 → 手动操作 → “立即跑一轮” 里跑。之后按 `schedule.yaml` 里的时间自动跑
（默认工作日 07:00 和 17:00、周末 09:00，按你的时区）。

## 升级

发布版本是 git 标签 `vX.Y.Z`。升级前先看[更新日志](../CHANGELOG.md)里那一版写了什么：需要你手动做的事会写在里面。

```bash
git status                                     # 必须是干净的（data/ 和 .env 被忽略，没关系）
git fetch --tags && git tag --list 'v*' --sort=-v:refname
scripts/ops/deploy.sh --ref v2.0.1 --dry-run   # 列出每一步，不做任何改动
scripts/ops/deploy.sh --ref v2.0.1
```

部署脚本会依次：检查工具、切到这个标签、装依赖、迁移你的配置文件（原文件留在 `data/config/.backup/`）、备份数据库、重建镜像、
等正在跑的轮次结束、重启服务、迁移数据库（迁移前自己再备份一次）、重启 AI worker 服务、跑 doctor。哪一步失败就停在哪一步，并告诉你该怎么办；
每一步都可以重复执行。

AI worker 这一步会重新安装第 5 步的服务（macOS 上是 launchd，Linux 上是 systemd 用户单元）。如果 worker 由你自己的进程管理工具在跑，
加上 `--no-ai-worker`，升级完自己重启它。

想退回去，就部署上一个标签：`scripts/ops/deploy.sh --ref <上一个标签>`。如果你要离开的那一版迁移过数据库，还要恢复升级时自动做的那份备份。
在 Linux 上从容器以 root 运行的旧版本升级，要先修正一次文件归属。详见 [upgrade.zh.md](upgrade.zh.md)、[deploy.zh.md](deploy.zh.md)。

## 备份

runner 每天夜里（默认 03:30）备份到 `data/backups/`：一份数据库 dump，加一个 `.config.tgz`，里面是你的配置（`data/config/`）和画像
（`data/profile/`）。保留最近 14 天每天最新的一份，和最近 8 周每周最新的一份。数据库迁移前它会额外做一份安全备份，备份成功了才迁移。
`.env` 和 `.auth/` 不在任何备份里：自己留一份。

```bash
scripts/ops/backup.sh            # 手动备份（数据库、配置和画像）；手动备份不会被自动清理
scripts/ops/restore.sh --list    # 所有备份，从新到旧，带时间
scripts/ops/restore.sh --latest --drop  # 演练：把最新一份恢复到临时数据库、对比行数，然后删掉临时库（你的数据不受影响）
```

真正恢复（`--target jobradar --yes`，配置和画像也要恢复的话再加 `--with-config`）时，先恢复到临时数据库，再停掉 web、runner 和 AI worker，
通过改名把两个数据库对调，然后全部重新启动。原来的数据库留作安全副本，选错了文件也能撤回。

`data/backups/` 在项目目录里。想防硬盘坏掉，把它纳入你自己的备份流程，拷到别处；`.config.tgz` 要当密钥一样对待（里面可能有代理凭据）。
恢复的全部细节见 [backup-restore.zh.md](backup-restore.zh.md)。

永远不要执行 `docker compose down -v`：`-v` 会删掉数据库卷。停服务用 `docker compose stop` 或 `pnpm stack:down`。

## 卸载

**这会删掉数据库、你的画像、配置和登录状态，无法撤销。** 先做最后一份备份并拷到安全的地方（`scripts/ops/backup.sh`，然后拷走
`data/backups/`；以后可能还会回来的话，`data/profile/` 和 `data/config/` 也留一份）。

```bash
# 1. AI worker 服务（macOS 上的 launchd，Linux 上的 systemd 用户单元）
scripts/ops/uninstall-ai-worker.sh --purge-logs

# 2. 容器和网络（这个项目目录的 compose 项目）
docker compose down

# 3. 数据库卷（所有岗位、申请和 AI 结果）；没设 JOBRADAR_PG_VOLUME 时就是 jobradar-pg
docker volume rm jobradar-pg

# 4. 本地数据、密钥和日志
rm -rf data .auth .env
rm -rf ~/Library/Logs/job-radar                          # 仅 macOS

# 5. 项目目录本身
cd .. && rm -rf job-radar
```

`docker image prune` 可以删掉构建出的镜像。如果你为 Job Radar 设置过登录时启动 Docker、电源设置或 Tailscale，请手动改回去。
你的 `claude` 和 `codex` 登录是你自己的，会保留。详见 [upgrade.zh.md](upgrade.zh.md)。

## 常见问题排查

| 你看到 | 怎么办 |
|---|---|
| `pnpm doctor` 输出的是 pnpm 自己的检查 | 用 `pnpm run doctor`。 |
| `Cannot connect to the Docker daemon` | 启动 Docker：macOS 上 `open -a Docker`，Linux 上 `sudo systemctl start docker`。 |
| `docker compose` 不认 `env_file` 或 `required` | 你的 Compose 低于 2.24，升级 Docker Desktop 或 compose 插件。 |
| 端口被占用 | 在 `.env` 里换端口：看板用 `JOB_RADAR_WEB_PORT`（默认 3000），数据库用 `DB_HOST_PORT`（默认 5433）。然后 `docker compose up -d`。 |
| 向导提示保存失败（Linux） | `data/` 不归容器运行的那个用户所有。在 `.env` 里把 `PUID` / `PGID` 设成 `id -u` / `id -g`，执行一次 `sudo chown -R "$(id -u):$(id -g)" data .auth`，再 `docker compose up -d`。doctor 的 `data.ownership` 会列出哪里不对。 |
| `/sources` 上的 AI worker 卡片显示“无响应” | `pnpm ai-worker`（或 launchd / systemd 服务）在跑吗？看它的日志（macOS 是 `data/logs/ai-worker.err.log`，systemd 是 `journalctl --user -u job-radar-ai-worker`）。 |
| 岗位进来了，但一直没分数 | 检查 `claude auth status` / `codex login status`，再跑 `pnpm ai:probe`。doctor 里 `ai.profile` 是 ❌ 的话，打开 `/me` 填上简介或技能：没有画像就不打分。 |
| `another ai-worker is running against this database` | 已经有一个在跑了（通常是 launchd 或 systemd 服务）。这没问题；想手动跑一个，先把它停掉。 |
| 什么都没采集 | 完成或跳过设置向导；doctor 的 `setup.completed` 和 `cycle.last` 会说明 runner 在等什么。 |
| 某个来源显示“未配置” | `.env` 里缺它的 key。补上后执行 `docker compose up -d`，或者把这个来源关掉。 |
| 出现了你没想到的登录页 | `.env` 里设了口令（`JOB_RADAR_WEB_PASSWORD_HASH`）。登录，或者删掉这一行再 `docker compose up -d web`。如果怎么都登不进去，多半是哈希没复制完整：重新运行 `pnpm web:password`。 |
| `421 Misdirected Request` | 你用了看板不认识的主机名访问。用 `127.0.0.1`、`*.ts.net` 地址，或把名字加进 `JOB_RADAR_ALLOWED_HOSTS`。 |
| `pnpm telegram:test` 报 `chat not found` | chat id 不对，或者你还没在 bot 里点 Start。 |
| Telegram 按钮点了没反应 | 别的程序在用同一个 bot token（runner 日志里 `getUpdates` 返回 409）。给 Job Radar 单独建一个 bot。 |

还是解决不了？运行 `pnpm run doctor --json`，去掉个人信息后提 issue。日常使用、各页面和日志见 [usage.zh.md](usage.zh.md)。
