# 部署、升级、回滚和 7 天无人值守验收

这份指南把 Job Radar 真正部署到一台主机上，并说明怎么确认它在无人值守地正常运行。与主机相关的步骤（Docker Desktop、电源设置、launchd）按 macOS 写；Linux 或 Windows（WSL2）请看[平台说明](installation.zh.md#macoslinuxwindows)，并使用与平台无关的部分（部署脚本、doctor、升级和回滚）。

- 第一次部署：先做第 1 节的清单，再运行第 2 节的 `scripts/ops/deploy.sh`。
- 平时：用第 3 节的 `pnpm run doctor` 看一眼就知道"系统是不是健康、缺什么"。
- 升级和回滚：第 4、5 节。
- 7 天无人值守验收：第 6 节，记录写在你自己的文件里（例如 `unattended-<date>.md`）。

约定：标 **【你来做】** 的步骤只有你本人能做（点系统弹窗、输入密码、登录账号、填令牌）；agent 不能也不应该代劳。令牌和密码只写进 `.env` 或各自的登录界面，不要贴进聊天、不要提交到 git。命令默认在项目目录（包含 `package.json`、`compose.yaml`、`config/`、`data/` 的那个目录）下执行。

## 1. 第一次部署前的清单  **【你来做】**

每一项做完打勾。细节都在 [host-setup.zh.md](host-setup.zh.md)，这里只列顺序和"怎么确认做对了"。

| # | 要做的事 | 细节 | 怎么确认 |
|---|---|---|---|
| ☐ 1 | 如果项目放在外接卷上：外接卷挂载正确（没有 `Data 1` 这类重复挂载）；Docker Desktop 能读写外接卷 | host-setup 第 0、1 节 | `ls /Volumes` 里该卷只出现一次；deploy 脚本第一步会检查 |
| ☐ 2 | Docker Desktop 登录时自动启动；Mac 开机后自动登录 | host-setup 第 2 节 | 重启 Mac 后不用点任何东西，`docker info` 能返回 |
| ☐ 3 | 断电后自动开机、不休眠：`sudo pmset autorestart 1`、`sudo pmset -a sleep 0` | host-setup 第 3 节 | doctor 的「Mac 断电自启、不休眠」是 ✅ |
| ☐ 4 | claude 和（或）codex 在宿主机上登录，或在 `.env` 里设置了 API key | host-setup 第 6 节 | 终端里 `claude auth status` 显示 `loggedIn: true`，`codex login status` 显示 Logged in |
| ☐ 5 | Telegram：@BotFather 建 bot，token 和 chat id 写进 `.env`；`notify.yaml` 里 `telegram.enabled: true` | [telegram.zh.md](telegram.zh.md)、host-setup 第 6 节 | `pnpm telegram:test` 手机收到测试消息 |
| ☐ 6 | 采集通道的 key（Bright Data、Apify、Tavily、JSearch、Gmail……）按需写进 `.env`，并确认各通道月预算 | 各通道的指南（[brightdata.zh.md](brightdata.zh.md)、[apify.zh.md](apify.zh.md) 等）；`.env.example` 有变量名 | doctor 的「采集通道与预算」里没有「缺 XXX」 |
| ☐ 7 | 画像：`data/profile/me.yaml`、`preferences.yaml` 写好；配置：`pnpm config:init` 生成用户配置目录 `data/config/`（之后改配置都改这里，见 [configuration.zh.md](configuration.zh.md)） | `config/profile.example/` | `pnpm config:check` 全部通过 |
| ☐ 8 | Tailscale：Mac 上打开并 Connect、勾选 Start at login；手机装同一账号；`tailscale serve --bg 3000`；把 `tailscale serve status` 里的地址写进 `notify.yaml: public_base_url` | host-setup 第 7 节 | 手机浏览器能打开那个地址；doctor 的「手机访问」三项都是 ✅ |
| ☐ 9 | LinkedIn 登录态（可选，`linkedin-session` 通道上线后） | [linkedin-session.zh.md](linkedin-session.zh.md) | doctor 的「LinkedIn 级联可用，登录态」没有 ⚠️ |
| ☐ 10 | `cp .env.example .env`（只在第一次），按 4、5、6 填值 | `.env.example` | `.env` 已在 `.gitignore`，`git status` 看不到它 |

不要用 `tailscale funnel`（会把页面暴露到公网）。永远不要执行 `docker compose down -v`（会删除数据库卷）。

## 2. 部署：`scripts/ops/deploy.sh`

先看它要做什么（只打印，不改动任何东西）：

```bash
scripts/ops/deploy.sh --dry-run
```

输出是 11 个步骤和每一步要执行的命令；如果有条件现在不满足（比如不在 main 分支、有未提交的改动），会用 `⚠ 实际运行会在这里停下` 标出来。确认没问题后：

```bash
scripts/ops/deploy.sh
```

在**主 checkout** 里运行（不要在 worktree 或 feature 分支里；不带 `--ref` 时跟随 `main`，带 `--ref <tag>` 时检出该 tag 并停在 detached HEAD；ai-worker 也是从主 checkout 启动的）。脚本按顺序做，**任何一步失败就停下**，并告诉你是第几步、为什么、怎么办；已完成的步骤不会回滚，修好后重新运行即可（每一步都是幂等的）：

| 步骤 | 做什么 | 失败时通常是 |
|---|---|---|
| 1 preflight | git / docker / node / pnpm 都在，Docker 在运行，外接卷没有重复挂载 | Docker Desktop 没起来 |
| 2 pull | 没有未提交的改动。不带 `--ref`：当前在 main，`git fetch` 后快进到 `origin/main`。带 `--ref <tag>`：fetch 后检出该 tag（或分支） | 在别的分支（不带 `--ref` 时）；本地有没推送的提交（分叉） |
| 3 install | `pnpm install --frozen-lockfile` | 网络 |
| 4 config | 建 `data/config`、`data/profile`、`data/backups`、`data/exports`；`pnpm config:init`（把用户配置目录 `data/config` 缺的文件从默认配置 `config/` 复制过去，从不覆盖；第一次部署时用户目录是空的，于是整份复制）；`pnpm config:migrate --write`（`config_version` 升级，原文件备份到 `data/config/.backup/<时间>/`）；`pnpm config:check`（两层都查，并写出每份配置读的是哪一层）；检查 `.env`；`docker compose config` | YAML 写错了（报错会指出文件和字段）；某个文件的 `config_version` 比代码新（代码回退了） |
| 5 backup | db 已经在运行就先做一份 `pre-deploy` 备份（第一次部署跳过） | 备份失败时不继续升级 |
| 6 build | `docker compose -p job-radar build` | 磁盘满 |
| 7 up | 先 `pnpm ops:drain`：有轮次正在运行就等它结束（最长 `schedule.yaml: deploy.drain_timeout_seconds`，900 秒），因为重建 runner 会打断它。然后 `docker compose up -d --wait`：db / web / runner / jobspy 都要变成 healthy（最长 300 秒） | 某个服务起不来：脚本会列出 `docker compose ps` 和看日志的命令。等完了轮次还在跑只打印警告（`pnpm ops:drain` 退出码 1），没能检查（退出码 3：配置或数据库出错，或某个查询卡住）也只打印警告：部署继续，runner 启动时的补跑会重跑那个定时时段 |
| 8 prune | 清理 Docker：构建缓存按最近使用只留 `schedule.yaml: deploy.build_cache_keep_gb`（`docker builder prune -f --max-used-space 5gb`），删悬空镜像（`docker image prune -f`，不带 `-a`）。从不碰数据卷，不删正在使用的镜像 | 不会让部署失败：命令出错只打印 ⚠ 继续（比如 Docker 太旧不认 `--max-used-space`） |
| 9 migrate | `pnpm migrate:run`（runner 启动时也会自动迁移，这里是确认；已是最新则什么都不做）。有待执行的迁移时先做一份 `premigrate` 备份（数据库加配置压缩包），备份失败就不迁移（`schedule.yaml` 的 `backup.pre_migrate`） | 迁移 SQL 有问题；迁移前备份失败 |
| 10 ai-worker | `scripts/ops/install-ai-worker.sh`：安装或重启 ai-worker：macOS 上是 launchd agent，Linux 上是 systemd 用户单元 `job-radar-ai-worker.service`（macOS 上也会替换还装在旧标签 `de.jobradar.ai-worker` 下的 agent，见 host-setup）。它正在处理的 AI 请求（比如给一整轮打分的 `run_ai`）不会丢：回到队列，重启后接着跑（见下面“被重启打断的工作”） | `claude` / `codex` 不在 PATH 里 |
| 11 doctor | 等 20 秒让心跳到位，再运行 `pnpm run doctor` | 见下 |

选项：`--skip-pull`（不动 git，按当前代码部署，回滚用）、`--ref <标签|分支>`（部署 `v2.0.0` 这样的发布标签而不是 `main`，见 [upgrade.zh.md](upgrade.zh.md)）、`--no-backup`、`--no-prune`（跳过第 8 步的清理）、`--no-ai-worker`、`--no-drain`（第 7 步不等正在运行的轮次）、`--drain-timeout 秒`（代替 `deploy.drain_timeout_seconds`）、`--branch`、`--remote`、`--wait-timeout 秒`、`--settle 秒`；`--help` 看全部。

第 7、8 步的设置在 `schedule.yaml` 的 `deploy` 块（只有部署脚本读它，改完下次部署生效）。部署脚本和备份脚本读 `schedule.yaml` 时和代码一样：先读用户配置 `data/config/schedule.yaml`，没有才读默认的 `config/schedule.yaml`：

| 键 | 默认 | 含义 |
|---|---|---|
| `deploy.prune_build_cache` | true | 部署后清理 Docker 构建缓存 |
| `deploy.build_cache_keep_gb` | 5 | 按最近使用保留这么多 GB 的构建缓存，下次构建仍然快；0 = 清掉全部未使用的构建缓存 |
| `deploy.prune_dangling_images` | true | 删除悬空镜像（旧构建留下的、没有标签的镜像） |
| `deploy.drain_timeout_seconds` | 900 | 第 7 步重建容器前，最多等这么多秒让正在运行的轮次结束；0 = 不等 |
| `deploy.drain_poll_seconds` | 10 | 第 7 步等待时多久看一次 |

### 被重启打断的工作

部署（或者崩溃、`launchctl kickstart`）可能在 runner 或 ai-worker 干活时重启它们。不会有工作被悄悄丢掉：

- **控制请求**（`run_ai`、打分、翻译、重打分、兴趣建议）：被重启打断的请求回到队列（pending），进程起来后重新执行。打分和推送从断开的地方接着做：已有分数的岗位不会再打分，已推送的岗位不会再推送。同一个请求被打断超过 `ai.yaml: host_worker.requeue_interrupted_max` 次（3）就改为失败，免得一个会把进程搞崩的请求无限循环；设为 0 恢复旧行为（立刻失败）。runner 也用这个值。有两类请求不重新排队而是直接失败，还需要的话再点一次：“测试”按钮，和手动“立即采集”（下面的补跑已经会重跑采集，再排一个只会采两遍）。
- **轮次**：正在运行的轮次没法从中间接着跑，所以第 7 步先等它（见上）。如果还是被打断了（等待超时、`--no-drain`、崩溃），这一轮记为失败；runner 启动时的补跑不把它算作“已经跑过”，它所属的定时时段会马上重跑。只重跑一次：如果重跑的这一轮又被打断（比如一轮本身会把 runner 搞崩），它就算“跑过”，崩溃不会变成反复的全量采集。

### 只能有一个 ai-worker

ai-worker 运行期间一直持有一个 Postgres 会话级 advisory lock；第二个会以退出码 3 退出（不带 `--once` 时先等 `ai.yaml: host_worker.already_running_wait_seconds`，60 秒），所以同一个请求不会跑两次。两个局限：

- 这把锁需要真正的会话。如果 `DATABASE_URL` 经过事务模式的连接池（例如 PgBouncer `pool_mode = transaction`），锁就不跟 worker 的连接绑定，起不到保护作用：让 ai-worker 直连 Postgres，或者用会话模式的池。compose 的配置是直连。
- 数据库重启时所有锁都没了。worker 在下一次心跳（`host_worker.heartbeat_seconds`）时重新拿锁；如果恰好在这个空档里启动了第二个 worker，锁归它，它会把第一个正在执行的请求放回队列（于是可能跑两次），第一个在下一次心跳时退出。只有在数据库重启期间手动再起一个 worker 才会碰到。

第 10 步装的 ai-worker 的日志位置：

- **限制**：launchd 自己打不开外接卷上的文件。plist 的 `StandardOutPath` / `StandardErrorPath` 指向外接卷时，任务根本起不来（`launchctl print` 显示 `last exit code = 78: EX_CONFIG`；用 `/bin/sh` 和 node 都一样，在 macOS 上实测）。`WorkingDirectory` 和程序文件在外接卷上没问题，launchd 启动的 node 进程也能往外接卷写文件。所以**不要**把 plist 的这两个路径改到外接卷上。
- ai-worker 自己把输出写到 `data/logs/ai-worker.out.log` / `ai-worker.err.log`（项目所在的卷），超过 `ai.yaml: host_worker.log_max_mb`（10 MB）复制后截断，留 `log_keep`（3）份 `.1`…`.3`。
- launchd 的输出文件留在内置盘：`~/Library/Logs/job-radar/ai-worker.launchd.log`，只接住 worker 打开自己的日志之前的输出和崩溃；同样按大小轮转，轮转出来的旧副本放到 `data/logs/`，内置盘上始终只有这一个小文件。
- 更早版本安装的 ai-worker 还把日志写在 `~/Library/Logs/job-radar/ai-worker.{out,err}.log`（doctor 的 `aiworker.launchd` 会 ⚠️ 提示）：重新运行 `scripts/ops/install-ai-worker.sh`（或 `scripts/ops/deploy.sh`），旧日志会一次性搬到 `data/logs/ai-worker.{out,err}.before-upgrade.log`。

退出码：`0` 部署完成且 doctor 没有问题（或只有 ⚠️）；`1` 某一步失败；`2` 部署完成，但 doctor 报告了 ❌（按它的「怎么办」处理，处理完再运行 `pnpm run doctor`）。

第一次部署时 doctor 出现 ⚠️ 或 ❌ 很正常（比如 Tailscale 没连、付费渠道没填 key；Telegram 没开时 doctor 只当它是可选项）：按第 1 节的清单补齐，直到 `pnpm run doctor` 全是 ✅。然后做一次重启验证（host-setup 第 5 节：退出再打开 Docker Desktop，一两分钟内四个服务回到 healthy），最好再重启一次 Mac，确认不用任何人干预整套系统都回来。

## 3. 日常检查：`pnpm run doctor`

```bash
pnpm run doctor              # 逐项检查，✅ / ⚠️ / ❌，每个 ⚠️ 和 ❌ 下面有「怎么办」
pnpm run doctor --json       # 同样的内容，JSON，给脚本用
pnpm run doctor --only compose --only tailscale   # 只跑 id 以这些前缀开头的检查
pnpm run doctor --lang zh    # 用另一种语言输出报告（默认：language.yaml 的 cli.locale，见 languages.zh.md）
```

注意写 `pnpm run doctor`：`pnpm doctor` 是 pnpm 自带的命令（检查 pnpm 自己的安装），不会运行这个脚本。

**只读**：不发 Telegram 消息、不调用任何 AI、不花钱、不改任何东西；claude / codex 只查登录状态（`claude auth status`、`codex login status`），Telegram 只检查 token 和 chat id 是否配置且格式正确。

退出码反映最差的一项：`0` 全部 ✅，`1` 有 ⚠️，`2` 有 ❌，`3` doctor 自己没能运行（参数错误、配置读不了）。每一项的 `id` 稳定，`--json` 里能按 id 取。

### 每一项检查什么

| id | 检查 | ❌ / ⚠️ 的意思和第一步 |
|---|---|---|
| `docker.daemon` | Docker 在运行 | ❌ Docker Desktop 没起来：`open -a Docker` |
| `compose.db` `compose.web` `compose.runner` `compose.jobspy` | compose 项目 `job-radar` 的四个服务在运行且 healthy；端口只绑在 127.0.0.1 | ❌ 容器停了或 unhealthy：看日志命令（`docker compose -p job-radar logs --tail 100 <服务>`）；端口绑到了 0.0.0.0 也是 ❌（违反只绑本机的规则），除非 `JOB_RADAR_WEB_BIND` 有意开放 web **并且**设了网页口令（没设口令：❌，提示先设口令）。web 发布到了回环以外、`JOB_RADAR_WEB_BIND` 却没设或是回环地址，也是 ❌：本机免登录仍然开着，要把 `JOB_RADAR_WEB_BIND` 设成发布的地址。⚠️：服务在宿主机上以进程方式运行（UAT 或 `pnpm runner`），不是 compose 容器——能用，但重启后不会自己回来 |
| `compose.project` | compose 项目的容器是从这份检出启动的（`com.docker.compose.project.working_dir`） | ⚠️ 另一份检出用同一个项目名运行着容器：两者会接管彼此的容器并共用数据库卷。给第二个实例起自己的名字，见 [multiple-instances.zh.md](multiple-instances.zh.md) |
| `web.http` | 宿主机访问 `doctor.web_url` 的 `/api/health` 返回 200，数据库 ok | ❌ web 没起来或连不上数据库 |
| `db.connect` | 宿主机能连上数据库（`DATABASE_URL`，没设就按 `.env` 里的 `POSTGRES_*` 和 `DB_HOST_PORT` 拼） | ❌ db 没起来，或 `.env` 里的口令不对 |
| `db.migrations` | 数据库迁移是最新的（对照 `drizzle/meta/_journal.json`） | ❌ 缺迁移：`scripts/ops/deploy.sh` 或 `pnpm db:migrate`；⚠️ 数据库比代码新：是不是回滚了代码（见第 5 节） |
| `runner.heartbeat` | runner 最新心跳在 `RUNNER_HEALTH_MAX_AGE_SECONDS`（默认 120 秒）内 | ❌ runner 卡住或停了：看日志后 `docker compose restart runner` |
| `aiworker.launchd` | launchd 里装了 `io.jobradar.ai-worker` 且状态是 running（Linux 上：systemd 用户单元 `job-radar-ai-worker.service` 处于 active，用 `systemctl --user show` 读取） | ⚠️ 只有旧标签 `de.jobradar.ai-worker` 在运行：运行 `scripts/ops/install-ai-worker.sh` 迁移；❌ 没装或没在运行：先看 `~/Library/Logs/job-radar/ai-worker.launchd.log`（启动失败和崩溃），再 `scripts/ops/install-ai-worker.sh`；⚠️ 没装 launchd 但有心跳（手动启动的）；⚠️ 在运行但日志还写在内置盘的旧位置（旧版本装的）：重新运行 `scripts/ops/install-ai-worker.sh` |
| `aiworker.heartbeat` | ai-worker 心跳在 `ai.yaml: host_worker.offline_after_seconds` 内 | ❌ 离线：`data/logs/ai-worker.err.log`，崩溃看 `~/Library/Logs/job-radar/ai-worker.launchd.log` |
| `ai.claude` `ai.codex` | 两个订阅 CLI 已登录 | ⚠️ 一个没登录（另一个还能用）；❌ 两个都没登录，AI 打分和翻译会停：`claude` 里 `/login`、`codex login` |
| `telegram.credentials` `telegram.enabled` | `.env` 里 token 和 chat id 已配置；`notify.yaml: telegram.enabled` 是 true | Telegram 关着且没配：显示为可选（✅）；⚠️ 已填凭据但开关没开；❌ 开关开了但凭据没配，不会推送 |
| `network.public_url` | `notify.yaml: public_base_url` 已设置，且从本机能访问 | ⚠️ 没设置（消息里没有"打开详情"链接）；❌ 设置了但访问不了（手机上也会打不开） |
| `tailscale.status` `tailscale.serve` | Tailscale 在运行；`tailscale serve` 把 web 端口暴露给 tailnet；Funnel 是关的 | ⚠️ 没连接或没有 serve 规则；❌ Funnel 打开了（页面在公网上）：`tailscale serve reset` |
| `web.access` | 可选的网页口令：以哈希设置 ✅；明文，或短于 `ui.yaml: web_access.min_password_length` ⚠️；读不懂的哈希 ❌（谁都登录不了）；scrypt `N` 低于 16384 的哈希 ⚠️（重新运行 `pnpm web:password`）；设了口令、web 在 compose 之外运行且 `JOB_RADAR_WEB_BIND` 没设 ⚠️（`http://localhost` 也要口令：设 `JOB_RADAR_WEB_BIND=127.0.0.1`）；没有口令时，web 只监听回环地址且 `tailscale serve` 没有转发到它 ✅，否则 ⚠️ | `pnpm web:password`，把那一行贴进 `.env`，`docker compose up -d web`（见 [configuration.zh.md](configuration.zh.md#网页访问可选口令监听地址和端口)） |
| `backup.recent` | 备份目录存在，最新一份在 `backup.max_age_hours`（默认 30）内 | ❌ 目录不存在或备份太旧：见 [backup-restore.zh.md](backup-restore.zh.md)；⚠️ 目录里还没有自动备份（刚部署） |
| `data.ownership` | 仅 Linux：`data/` 和 `.auth/` 下的一切都属于容器运行用的 uid（`PUID`，默认 1000） | ⚠️ 有文件属于别的用户（旧版本或 `sudo` 命令留下的），容器写不了：`sudo chown -R <PUID>:<PGID> data .auth`，见 [upgrade.zh.md](upgrade.zh.md) |
| `data.traps` | AI 陷阱：有陷阱的岗位数（总数 / 近 `scan.recent_days` 天）、还没扫描的岗位数 | ⚠️ 积压超过 `scan.backlog_warn`：`pnpm traps:scan --write`；⚠️ `traps.yaml` 读不出来 / `enabled: false` / 还没迁移。见 [ai-traps.zh.md](ai-traps.zh.md) |
| `disk.backups` `disk.docker` | 备份所在的卷、Docker 数据所在的卷剩余空间。`disk.docker` 量的是 Docker Desktop 设置里的 `DataFolder`（`~/Library/Group Containers/group.com.docker/settings-store.json`，读不到就按默认位置 `~/Library/Containers/com.docker.docker/Data/vms/0/data`），detail 里写出量的路径 | ⚠️ 低于 `warn_free_disk_gb`（20），❌ 低于 `min_free_disk_gb`（5）。清理：`docker system df`、`docker builder prune`、旧的手动备份、`data/logs/` |
| `disk.docker_location` | Docker 的数据目录（`DataFolder`）和项目在同一个卷上（按设备号比较，不写死卷名） | ⚠️ 不在：数据库、镜像和构建缓存都占着系统盘。如果内置盘不大，把 Docker 数据目录搬到外置盘（配置了 `doctor.storage_guide` 的话按它的说明） |
| `disk.internal` | Mac 系统盘（`/System/Volumes/Data`）的剩余空间 | ⚠️ 低于 `internal_warn_free_disk_gb`（30），❌ 低于 `internal_min_free_disk_gb`（10）：先确认 `disk.docker_location` 是 ✅，其余自行清理 |
| `channels.<id>` | 每个**启用**的通道：缺 key、熔断、上一轮全部失败、本月预算和免费额度（达到 `notify.yaml: alerts.budget_thresholds` 的第一档 ⚠️，用完 ❌） | ⚠️ 通常是缺 key 或熔断（只影响这个通道，其他通道不受影响）；`/sources` 页有详情 |
| `channels.linkedin` | LinkedIn 级联里至少有一个可用通道，或者一个都没设置（LinkedIn 是可选的）；启用了 `linkedin-session` 时有登录态文件 | ❌ 有设置好的通道，但都不能运行（熔断或没登记） |
| `budget.paid` `budget.ai_api` | 付费通道本月合计、AI 付费 API 本月估算 vs 预算 | ⚠️ 达到阈值，❌ 用完 |
| `cycle.last` | 上一轮的状态；排定的轮次有没有错过（超过 `doctor.cycle_grace_minutes` 还没开始） | ❌ 上一轮失败或错过了轮次：runner 在不在、Mac 有没有睡眠 |
| `cycle.next` | 下一次轮次的时间 | ❌ 三个轮次都关了 |
| `ai.profile` | `data/profile/me.yaml` 有简介（summary）或技能（skills），AI 打分才会开始 | ❌ 两项都空而且有岗位在等打分；⚠️ 两项都空但还没有岗位在等，或者 me.yaml 读不了。怎么办：打开 /me 至少填一项保存，下一轮开始打分。此时今日页和 /me 顶部有"画像不完整，AI 打分已暂停"横幅 |
| `config.guards` | `ai.yaml` 里的 CLI 命令是 `claude` / `codex`，`codex_cli.config_overrides` 只有允许的键，接收 key 的服务都指向厂商自己的主机，没有设 `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS` | ❌ 某个 `command` 被拒绝（那个 CLI 不会运行）；⚠️ 有覆盖项被忽略、改过的 `base_url` / `api_base_url` 被拒绝或（放行后）被使用，或设了放行变量。见 [ai-providers.zh.md](ai-providers.zh.md#ai-worker-不从-aiyaml-接受的东西) |
| `ai.backlog` | AI 请求队列、等打分的岗位数、最近一次 `run_ai` 的结果（因画像不完整没有打分时写明原因，不算成功） | ⚠️ 积压：ai-worker 在不在 |
| `config.layers` | 用户配置目录 `data/config` 存在且可写；列出覆盖了的 `shipped` 文件、版本落后（要迁移）的文件、还在读默认配置的 `user` 文件 | ❌ 目录不存在或不可写（`pnpm config:init`；查挂载）；❌ 某个文件的 `config_version` 比代码新（代码回退了：升级代码或从 `data/config/.backup/` 恢复）；⚠️ 覆盖了 `models.yaml` / `pipeline.yaml`：产品更新这些文件的内容不会生效，想跟随就删掉 `data/config` 里那份；⚠️ 版本落后：`pnpm config:migrate` 看改动，`--write` 写回 |
| `host.power` | `pmset` 里 autorestart 是 1、sleep 是 0 | ⚠️ 没设置：host-setup 第 3 节 |

doctor 的阈值和名字都在 `schedule.yaml`（用户配置 `data/config/` 里那份；改完不用重启，下次运行就生效）：

| 键 | 默认 | 含义 |
|---|---|---|
| `backup.max_age_hours` | 30 | 最新备份最老多少小时 |
| `doctor.compose_project` / `compose_services` | `job-radar` / db web runner jobspy | 检查哪个 compose 项目、哪几个服务；环境变量或 `.env` 里的 `COMPOSE_PROJECT_NAME` 优先（第二个实例） |
| `doctor.web_url` | `http://127.0.0.1:3000` | 宿主机访问网页的地址；临时用环境变量 `JOB_RADAR_DOCTOR_WEB_URL` 覆盖。设了 `JOB_RADAR_WEB_PORT` / `JOB_RADAR_WEB_BIND` 时，doctor 改用那个端口和地址（`0.0.0.0` 换成 `127.0.0.1`） |
| `doctor.probe_timeout_seconds` / `command_timeout_seconds` | 5 / 15 | 一次 HTTP 请求 / 一条命令最多等多久 |
| `doctor.min_free_disk_gb` / `warn_free_disk_gb` | 5 / 20 | 磁盘空间阈值（备份所在的卷、Docker 数据所在的卷） |
| `doctor.internal_min_free_disk_gb` / `internal_warn_free_disk_gb` | 10 / 30 | Mac 系统盘的阈值（`disk.internal`） |
| `doctor.storage_guide` | `docs/host-setup.md` | `disk.docker_location` 提示去看的指南（有自己的存储说明就改成它的路径） |
| `ai.yaml: host_worker.disk_check_minutes` | 10 | 宿主机 ai-worker 量一次 Docker 数据卷（即 `disk.docker` 那个卷，同样按 `DataFolder` 找）剩余空间的间隔。`/sources` 的低空间横幅用这个值，并注明来源；web 在容器里，自己量到的是容器磁盘，只在 ai-worker 超过 3 个间隔没有写入时才当后备显示 |
| `ai.yaml: host_worker.docker_data_path` | 不写 | Docker 数据目录的绝对路径，ai-worker 量磁盘时直接用它，不再读 `~/Library/Group Containers/group.com.docker/` 里的设置文件（launchd 下读它可能被 macOS 隐私授权弹窗一直卡住，测量超时、低空间横幅不更新）。在终端运行 `pnpm run doctor`，`disk.docker_location` 下的提示会给出该填的值 |
| `ai.yaml: host_worker.log_max_mb` / `log_keep` | 10 / 3 | ai-worker 日志（`data/logs/ai-worker.{out,err}.log` 和 launchd 的 `ai-worker.launchd.log`）超过多少 MB 轮转、留几份旧的（`.1` 最新） |
| `doctor.ai_backlog_warn` / `ai_oldest_pending_warn_minutes` / `ai_unscored_warn` | 40 / 30 / 200 | AI 积压阈值 |
| `doctor.cycle_grace_minutes` | 90 | 排定的轮次晚多久算错过 |
| `doctor.ai_worker_launchd_label` | `io.jobradar.ai-worker` | launchd 名称 |
| `doctor.linkedin_auth_dir` | `.auth` | 登录态目录（相对项目目录） |

数据库密码：用 `scripts/ops/deploy.sh`（或运行 `pnpm config:init`）做首次安装（`.env` 里没有 `POSTGRES_PASSWORD`，也还没有 `jobradar-pg` 卷）时，`pnpm config:init` 会在创建数据库之前往 `.env` 写一个随机密码（权限 0600，不打印），不再用众所周知的默认值。已有的数据库保留创建时的密码，所以那里什么都不会改；以后要改，先在数据库里用 `ALTER USER`，再更新 `.env`。`.env` 请自己备份：它不在任何备份里。

其他位置：数据库连接用 `DATABASE_URL`（没设就按 `.env` 的 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `DB_HOST_PORT` 拼），备份目录用 `RUNNER_BACKUP_DIR`（默认 `data/backups`，所以要在项目目录里运行）。

## 4. 升级

```bash
scripts/ops/deploy.sh --dry-run     # 先看一眼
scripts/ops/deploy.sh --ref v2.0.0   # 用户推荐：发布标签（见 upgrade.zh.md）
scripts/ops/deploy.sh               # 或跟随 main：拉最新 main、备份、构建、重启、清理 Docker 构建缓存、迁移、重启 ai-worker、doctor
```

升级前脚本会自动做一份 `jobradar-manual-…-pre-deploy.dump` 备份（手动备份不会被自动清理）。升级期间 web 和 runner 会重启几十秒；轮次正在运行时重启 runner 会让这一轮中断，下次启动时 `catch_up` 会补跑。想避开轮次：早轮 07:00、晚轮 17:00（工作日）、周末 09:00，在两轮之间升级。

升级后跑一次 `pnpm run doctor`，确认没有新的 ❌。

### 配置分层之后

- 线上配置是 `data/config/`（不进 git），网页只写这里；`config/` 是随代码发布的默认配置，部署 `git pull` 后它变了也只影响用户目录里**没有**的文件（`models.yaml`、`pipeline.yaml` 这类 `shipped` 文件，除非你覆盖了它们）。所以主 checkout 不会再因为网页保存而变脏，部署也不会再因此拒绝 pull。
- **从配置分层之前的版本升级**：第 4 步发现 `data/config` 是空的，`pnpm config:init` 把当时 `config/` 里的全部 `user` 类文件复制过去（和 `pnpm config:init --from config` 结果相同：此时默认配置就是旧的线上配置）。第 4 步之前已经在网页上保存、但还没提交的改动在 `config/` 里（checkout 是脏的，第 2 步会拒绝），先提交再部署。第 4 步到第 7 步之间（旧容器还在跑、还写 `config/`）不要在网页上保存设置。
- 升级带了配置格式变化（某个文件的 `config_version` 加了一版）：第 4 步的 `pnpm config:migrate --write` 自动迁移，原文件在 `data/config/.backup/<时间>/`。想先看：`pnpm config:migrate`（只打印 diff）。

## 5. 回滚

先判断问题出在哪：

- **代码有问题，数据库没动**（这次没有新迁移）：回到上一个好的提交即可。
- **这次升级带了新迁移**，并且新版本已经往里写过数据：迁移只往前走，旧代码在新库上可能出错（doctor 的 `db.migrations` 会提示"数据库比这份代码新"）。需要同时恢复数据库。

回滚代码：

```bash
git log --oneline -10                      # 找上一个好的提交
git switch --detach <提交>                 # 部署前的 pre-deploy 备份名字里有日期，可以对照
scripts/ops/deploy.sh --skip-pull          # 按当前 checkout 部署（不再拉 main）
```

之后要回到最新版本：`git switch main`，再 `scripts/ops/deploy.sh`。

配置：回滚到配置分层之前的代码时，旧代码读的是 `config/`（切换前的内容），切换后在网页上的改动只在 `data/config/` 里，需要的话手工拷回 `config/`。回滚到一个迁移之前的版本时，`data/config` 里迁移过的文件对旧代码来说"版本太新"（`config.layers` ❌）：用 `data/config/.backup/<时间>/` 里的原文件替换回去。

如果新迁移已经应用，还要恢复数据库（**会覆盖主库**，只有这种情况才做，详见 [backup-restore.zh.md](backup-restore.zh.md) 第 4 节）：

```bash
ls -lh data/backups | grep pre-deploy                    # 升级前自动留的备份
scripts/ops/restore.sh data/backups/<jobradar-manual-…-pre-deploy.dump> --target jobradar --yes
```

恢复会先把备份还原到临时库检查，再停 web、runner 和 ai-worker，把旧库改名为 `jobradar_before_restore_<时间戳>` 保留（恢复可以撤销），把还原好的副本改成主库名，再启动它们。runner 在迁移前做的 `…-premigrate-<已应用数>-<随附数>.dump` 同样可以用来恢复。恢复后 `pnpm run doctor` 应该回到全 ✅（`db.migrations` 会和回滚后的代码对上）。

回滚后在你记录的"事件记录"里写下：什么时候、为什么回滚、回到哪个提交。

## 6. 7 天无人值守验收

目标：部署之后连续 7 天，没有人工干预，每天的轮次、推送、AI、备份都正常。验收记录写在你自己的文件里（例如 `unattended-<date>.md`，用真正的开始日期命名），里面放观察表和事件记录。

### 开始前

1. 第 1 节清单全部打勾，`scripts/ops/deploy.sh` 成功，`pnpm run doctor` 全是 ✅（最多留下你明确接受的 ⚠️，并写进记录）。
2. 做过一次重启验证（退出再打开 Docker Desktop；最好重启一次 Mac）。
3. 在记录里写下：开始日期时间、部署的提交（`git rev-parse --short HEAD`）、开始时 doctor 的输出。
4. 之后 7 天**不要**手动重启服务、不要手动触发轮次、不要改配置——否则就不是"无人值守"。要改配置或升级，记录进"事件记录"，并重新开始计数。

### 每天一次（建议晚上 17:00 的晚轮和推送都完成之后）

```bash
pnpm run doctor                                            # 记下退出码和 ⚠️ ❌ 的项
docker compose exec -T db psql -U jobradar -d jobradar -x \
  -v day=$(TZ=Europe/Berlin date +%F) -v tz=Europe/Berlin <<'SQL'
select
  (select count(*) from cycles where kind <> 'manual' and status <> 'skipped' and (started_at at time zone :'tz')::date = :'day') as cycles,
  (select count(*) from cycles where kind <> 'manual' and status = 'succeeded' and (started_at at time zone :'tz')::date = :'day') as succeeded,
  (select count(*) from cycles where kind <> 'manual' and status = 'partial' and (started_at at time zone :'tz')::date = :'day') as partial,
  (select count(*) from cycles where kind <> 'manual' and status = 'failed' and (started_at at time zone :'tz')::date = :'day') as failed,
  (select count(*) from jobs where (first_seen_at at time zone :'tz')::date = :'day') as new_jobs,
  (select count(*) from notifications where kind = 'job' and sent_at is not null and (sent_at at time zone :'tz')::date = :'day') as pushed,
  (select count(*) from scores where score is not null and (scored_at at time zone :'tz')::date = :'day') as scored,
  (select count(*) from ai_usage where (at at time zone :'tz')::date = :'day') as ai_calls;
SQL
ls -lh data/backups | grep "jobradar-$(TZ=Europe/Berlin date +%Y%m%d)"       # 今天的备份
```

（`-U jobradar -d jobradar` 是 `.env` 没改过的默认值；改过 `POSTGRES_USER` / `POSTGRES_DB` 的换成你的。这些查询只读。）

把结果填进记录里当天的一行：

| 列 | 来自 | 正常是 |
|---|---|---|
| 轮次数 | `cycles` | 工作日 2（07:00、17:00），周末 1（09:00）；`catchup` 补跑的也算 |
| 成功率 | `succeeded` / `cycles`（`partial` 单独记，`failed` 必须是 0） | 全部 succeeded，或 partial 且原因是单个通道（通道互相隔离） |
| 新岗位 | `new_jobs` | 大于 0（具体数量看通道和市场，周末更少） |
| 推送数 | `pushed`；再看手机 Telegram 实际收到了几条、能不能点开详情链接 | 和手机上收到的一致；静默时段（22:00–07:00）的推送会延到早上 |
| AI 打分数 | `scored`（`ai_calls` 供参考：订阅 CLI 的费用计 0） | 大于 0；doctor 的 `ai.backlog` 没有 ⚠️ |
| 备份 | `ls` 看有没有当天 03:30 左右的 `.dump`（文件大小不为 0） | 有一份，且 doctor 的 `backup.recent` 是 ✅ |
| doctor | 退出码和 ⚠️ ❌ 的 id | 退出码 0 或 1；不能有 ❌ |
| 人工干预 | 这一天你有没有手动做过什么 | 无 |

### 怎么算通过

**某一天算通过**：轮次数符合预期、没有 `failed` 的轮次、有推送且手机上收到了、AI 打分数大于 0、当天有备份、doctor 没有 ❌、没有人工干预。

**7 天验收通过**：连续 7 天每一天都通过。中间任何一天不通过：在"事件记录"里写清楚原因和修复，修好后重新从第 1 天数起（除非你判断这是一次性的、不影响结论的偶发事件）。

建议在第 3 或第 4 天做一次"断电演练"（重启 Mac，不手动做任何事），记录多久之后 doctor 回到全 ✅。

### 结束时

在记录末尾写结论：7 天是否连续通过、遇到的事件、doctor 里长期存在的 ⚠️ 及原因、需要改进的地方。
