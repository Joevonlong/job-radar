# 主机设置（Mac 无人值守运行）

本页是 macOS 指南。Linux 或 Windows（WSL2）请看[平台说明](installation.zh.md#macoslinuxwindows)；这里关于 Docker Desktop、电源设置、自动登录和 launchd 的各节在那里不适用。

目标：Mac 通电后自己登录、Docker 自己起来、四个服务（db / web / runner / jobspy）自己恢复，宿主机上的 AI worker 自己拉起，手机通过 Tailscale 看板。

AI 用你本机的 Claude Code / Codex **订阅**，或 API key，或两者都用：容器里没有任何 AI 凭证，AI 和推送由宿主机上的 `ai-worker`（launchd）执行，见第 6 节和第 6b 节。

约定：标 **【你来做】** 的步骤只有你本人能做（要点系统弹窗、输入密码、登录账号）；agent 不能也不应该代劳。没标的命令可以直接复制执行（也可以让 agent 跑）。

在 Linux 上，第 1 到 3 节和第 6b 节里 launchd 的部分不适用：请先读[第 10 节](#10-linux)。

所有命令（包括 compose 命令）默认在项目目录下执行（包含 `package.json`、`compose.yaml`、`config/`、`data/` 的那个目录，例如 `~/job-radar`）。

## 0. 先决条件

- 如果项目放在外接卷上（例如 `/Volumes/Data`）：外接卷已挂载，且挂载点就叫你预期的名字（出现 `Data 1` 这类重复名字说明上一次没有正常卸载，先处理再继续）。
- 已安装 Docker Desktop（`/Applications/Docker.app`）。
- 仓库已 clone，`pnpm install` 通过。

## 1. 让 Docker Desktop 能读写外接卷  **【你来做】**

项目在内置盘上就跳过这一节。

容器要读写项目目录里的 `config`、`data/config`、`data/profile`、`data/backups`。macOS 对外接卷有隐私保护，第一次访问会弹窗。

1. 打开 Docker Desktop → Settings → Resources → File sharing，确认列表里有 `/Volumes`（一般默认已经有）。
2. 打开 系统设置 → 隐私与安全性 → 文件和文件夹 → Docker，打开 "Removable Volumes"（可移除宗卷）。如果列表里没有 Docker，先执行第 5 步让容器访问一次，弹窗出现时点"允许"，再回来确认。
3. 如果之后容器里读写 `/app/config` 报 `Operation not permitted`：系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 加入 Docker，然后重启 Docker Desktop。

## 2. Docker Desktop 登录时自动启动  **【你来做】**

1. Docker Desktop → Settings → General → 勾选 "Start Docker Desktop when you sign in to your computer"。
2. 如果这一项开不起来（Docker 设置里 `AutoStart` 是关闭的，并出现错误 "operation is not permitted when registering app service"）：去 系统设置 → 通用 → 登录项与扩展，在"允许在后台"里打开 Docker，再回到第 1 步重新勾选。
3. 检查：重启 Docker Desktop 后设置里该项保持勾选。

Docker Desktop 是用户会话里的程序：**必须有用户登录才会启动**。所以还要让 Mac 开机后自动登录：系统设置 → 用户与群组 → "自动登录"选你的账号（需要关闭 FileVault，这会让任何能接触到机器的人都能读取磁盘：**只在不随身携带的专用机器上这样做**；这是你自己的安全取舍，agent 不替你决定）。笔记本或有其他用途的机器请跳过这一步，重启后自己登录。

## 3. 断电后自动开机，并且不休眠  **【你来做】**（需要管理员密码）

```bash
sudo pmset autorestart 1      # 断电恢复后自动开机
sudo pmset -a sleep 0         # 不进入系统睡眠（显示器可以照常熄屏）
sudo pmset -a womp 1          # 允许网络唤醒（可选）
```

检查（不需要 sudo，agent 也可以跑）：

```bash
pmset -g | grep -E "autorestart|sleep|womp"
```

应该看到 `autorestart 1`、`sleep 0`。

## 4. 启动整个栈

```bash
mkdir -p data/profile data/backups      # 先建好挂载目录，避免 Docker 以 root 身份创建
cp .env.example .env                    # 只在第一次；.env 已 gitignore，不要提交
docker compose config > /dev/null       # 语法检查，无输出即正确
docker compose up -d --build            # 等价于 pnpm stack:up；第一次要构建镜像，几分钟
docker compose ps
```

`docker compose ps` 里 db、web、runner、jobspy 都应该是 `healthy`。runner 的状态来自它的 healthcheck（见第 8 节）。

`.env` 里第一次可以什么都不填：所有变量都有默认值（Linux 上要设 `PUID` / `PGID`，见第 10 节）。runner 和 jobspy sidecar 的内存上限分别是 2 GB 和 1 GB（`.env` 里的 `RUNNER_MEM_LIMIT`、`JOBSPY_MEM_LIMIT`）；碰到上限的服务会被杀掉并重启。容器不需要任何 AI 登录或密钥（不再挂载 `~/.codex/auth.json`）；AI 在宿主机上跑，见第 6 节。

## 5. 重启后自己恢复（验证一次）

compose 里所有服务都是 `restart: unless-stopped`：Docker 起来后会把上次没手动 stop 的容器拉起来；runner 起得比 db 早时会连接失败退出，再被重启策略拉起，直到 db 可用。

验证（会中断服务几十秒）：

1. 退出 Docker Desktop（菜单栏图标 → Quit Docker Desktop），再打开它。
2. `docker compose ps`：一两分钟内四个服务回到 `healthy`。
3. `docker compose logs --tail 20 runner`：应该看到 `migrations up to date`、`catch-up: ...`、`heartbeat every 30s`。

如果外接卷挂载得比 Docker 晚，容器会因为 bind mount 的源目录不存在而起不来：等卷挂载后执行 `docker compose up -d`。

## 6. 账号和令牌  **【你来做】**

下面这些都在你自己的终端里做，令牌不要贴进聊天或提交到 git。

### Claude（claude-cli provider）

1. 在终端运行 `claude`，进入后输入 `/login`，按提示用你的订阅账号登录；退出会话。登录保存在 macOS 钥匙串里，宿主机上的 ai-worker 直接用它；**不要**再生成 `claude setup-token`，也不要把令牌放进 `.env` 或容器。
2. 登录过期时（`/sources` 的 AI worker 卡片或 Telegram 告警提示 auth）重复第 1 步即可，不用重启 worker。

### Codex（codex-cli provider）

1. `codex login`（浏览器登录）；检查 `codex login status`。
2. 登录保存在 `~/.codex/`，ai-worker 直接读它；换了账号或过期后重新 `codex login`。

### Telegram

1. 在 Telegram 里找 @BotFather → `/newbot`，按提示起名，拿到 bot token。
2. 给你的 bot 发一条消息，再用浏览器访问 `https://api.telegram.org/bot<token>/getUpdates` 找到 `chat.id`。
3. token 和 chat id 写进 `.env`；具体变量名见 [telegram.zh.md](telegram.zh.md)。

## 6b. 安装 AI worker（宿主机，launchd）  **【你来做】**

AI worker 是宿主机上的一个 Node 进程：轮询数据库里的 AI 请求（每轮的 `run_ai`、网页的"翻译"、"重新打分"），用上面登录好的 `claude` / `codex` 执行，再发 Telegram 推送。它不运行时，AI 请求会排队，`/sources` 的 AI worker 卡片显示"没有响应"，超过 `ai.yaml: host_worker.offline_after_seconds`（默认 180 秒）runner 会发 Telegram 告警。

前提：主 checkout 里 `pnpm install` 已完成，`claude` 和 `codex` 在 PATH 上（例如在 `~/.local/bin`），Docker 里的数据库在运行：先运行 `docker compose up -d`（第 4 节），至少 `docker compose -p job-radar up -d db`。安装会等新 worker 拿到数据库锁并写出心跳，没有数据库就会回滚。

```bash
scripts/ops/install-ai-worker.sh --dry-run    # 只打印 plist（密码已遮蔽），什么都不改
scripts/ops/install-ai-worker.sh              # 构建 HEAD 的发布目录，写 ~/Library/LaunchAgents/io.jobradar.ai-worker.plist 并 bootstrap
scripts/ops/install-ai-worker.sh --print-release   # 已安装的 worker 从哪个发布目录运行
launchctl print gui/$(id -u)/io.jobradar.ai-worker | grep -E "state|pid"     # 应该是 state = running
tail -n 20 data/logs/ai-worker.out.log                                   # 日志；错误在 ai-worker.err.log
tail -n 20 ~/Library/Logs/job-radar/ai-worker.launchd.log                         # 只有启动失败和崩溃会写到这里
```

脚本会：让 worker 从主 checkout 的只读**发布目录** `data/releases/ai-worker/<提交>/` 运行（即使你在 worktree 里运行也一样；`--root <检出目录>` 可以指定别的）。不带 `--release <目录>` 时先用 `scripts/ops/prepare-release.sh` 构建 HEAD 的发布目录；`deploy.sh` 传入它构建好的那个。代码和出厂 `config/` 来自发布目录；`.env`、`data/config`、`data/profile`、`data/logs` 来自主 checkout。只有新 worker 证明已就绪才替换正在运行的那个，否则放回旧的（见 [deploy.zh.md](deploy.zh.md)《ai-worker 从发布目录运行》）。它写下 node / claude / codex / pnpm 的**绝对路径**和 PATH，`DATABASE_URL` 指向 `127.0.0.1:5433`（读 `.env` 的 POSTGRES_* 或 `DATABASE_URL`；密码只写进权限 600 的 plist，不会打印），`KeepAlive` 保证进程退出或被杀后自动拉起，登录时自动启动。重装/升级 node 或搬动 `claude` 后再运行一次脚本即可（它会替换已加载的那份）。之前的发布目录会保留（`schedule.yaml: deploy.ai_worker_releases_keep`，3 个）。

**标签改名：** launchd 标签以前是 `de.jobradar.ai-worker`。`install-ai-worker.sh`（因此 `deploy.sh` 也是）会自动、可重复地迁移：如果旧标签的 agent 已加载，或 `~/Library/LaunchAgents/` 里还有它的 plist，会先 bootout 并删掉旧 plist，再 bootstrap 新的 `io.jobradar.ai-worker`。`uninstall-ai-worker.sh` 两个标签都会清除。如果用户配置 `data/config/schedule.yaml` 里的 `doctor.ai_worker_launchd_label` 还是 `de.jobradar.ai-worker`，doctor 把它当作新标签。

日志：launchd **自己**打不开外接卷上的文件（plist 的 `StandardOutPath` 指向外接卷时，任务直接以 `EX_CONFIG` 退出，在 macOS 上实测），但它启动的 node 进程可以读写外接卷。所以 plist 给 worker 传 `--log-dir <主 checkout>/data/logs`，worker 自己把输出写进 `ai-worker.out.log` / `ai-worker.err.log`（`data/` 已 gitignore），超过 `ai.yaml: host_worker.log_max_mb`（10 MB）就轮转成 `.1`、`.2`……，留 `log_keep`（3）份。launchd 自己的输出文件 `~/Library/Logs/job-radar/ai-worker.launchd.log` 留在内置盘，只接住 worker 打开日志之前的输出和崩溃，同样受大小上限约束，轮转出来的旧副本放到 `data/logs/`。**不要**把 plist 的 `StandardOutPath` / `StandardErrorPath` 改到外接卷上，那样 ai-worker 根本起不来（详见 [deploy.zh.md](deploy.zh.md) 第 2 节）。worker 打不开 `data/logs`（卷没挂载、权限）时会在 launchd 的文件里写一行原因，退回写到那里。更早版本装的 ai-worker 把日志写在 `~/Library/Logs/job-radar/ai-worker.{out,err}.log`：下一次安装成功后，它们会被追加到 `data/logs/ai-worker.{out,err}.before-upgrade.log` 并删除（搬不动只打印警告）。

退出：plist 在发布目录里用 `node --import <发布目录里的 tsx loader> src/ai-worker/index.ts` 直接启动 worker（不经 `tsx` CLI 这层父进程，launchd 跟踪的就是 worker 本身；`NODE_OPTIONS` 设为空，不会预加载别的东西），并把 `ExitTimeOut` 设为 `schedule.yaml: deploy.ai_worker_stop_timeout_seconds`（60 秒）。worker 收到 SIGTERM 后有 `ai.yaml: host_worker.shutdown_grace_seconds`（30 秒）收尾当前请求和数据库连接，超时就在日志里记 `ERROR shutdown did not finish within …: forcing exit` 并以退出码 1 强制退出，由 launchd 重启；再收到一次信号立刻退出。被关机打断的请求不会丢：回到队列，重启后重新执行（`host_worker.requeue_interrupted_max`，见 [deploy.zh.md](deploy.zh.md#被重启打断的工作)）。心跳写入和磁盘测量各有超时 `host_worker.step_timeout_seconds`（20 秒），磁盘测量与心跳循环互不阻塞（launchd 下读 Docker 设置文件可能被 macOS 隐私授权弹窗卡住）。升级时 `deploy.sh` 会把 worker 切换到新的发布目录（第 10 步）；不用 `deploy.sh` 时重新运行 `scripts/ops/install-ai-worker.sh`。

注意：
- ai-worker 在外接卷上的发布目录里运行；开机时如果卷还没挂载，launchd 会每 10 秒重试直到成功。第一次访问外接卷时 macOS 可能弹出"允许 node 访问可移除宗卷"，点允许。
- Telegram 的 token / chat id 从 `.env` 读取（和 runner 一样）；推送由 worker 发，所以 worker 离线时没有岗位推送。
- 临时跑一次队列（不装服务）：`pnpm ai-worker --once`。

卸载：

```bash
scripts/ops/uninstall-ai-worker.sh            # launchctl bootout + 删除 plist（日志保留；--purge-logs 把 data/logs 和 ~/Library/Logs/job-radar 里的 ai-worker 日志一并删除）
```

## 7. 手机访问：Tailscale  **【你来做】**

web 只绑定 `127.0.0.1:3000`（不开放任何公网端口），手机通过 Tailscale 访问。

1. Mac 上打开 Tailscale（`/Applications/Tailscale.app`）并登录；如果显示 "Tailscale is stopped"，需要先点 Connect。手机上装 Tailscale，登录同一个账号。
2. 在 Tailscale 管理后台（login.tailscale.com → DNS）启用 MagicDNS 和 HTTPS Certificates（`tailscale serve` 的 https 需要）。
3. 在 Mac 终端执行：

```bash
tailscale serve --bg 3000
tailscale serve status
```

`status` 会打印形如 `https://<机器名>.<tailnet>.ts.net` 的地址，手机浏览器打开即可；它只在你的 tailnet 里可见。

4. 不要用 `tailscale funnel`：那会把页面暴露到公网。要撤销用 `tailscale serve reset`。
   web 只响应 `localhost`、`127.0.0.1`、`[::1]` 和 `*.ts.net`。用别的反向代理（Caddy、nginx，必须传下 `Host` 或
   `X-Forwarded-Host`）或局域网主机名访问时，把那个名字加进 `.env` 的 `JOB_RADAR_ALLOWED_HOSTS`（见
   [configuration.zh.md](configuration.zh.md#哪些主机名能访问-webjob_radar_allowed_hosts)），否则会得到 `421 Misdirected Request`。
5. Tailscale 随登录自启：Tailscale 设置里勾选 "Start at login"（菜单栏图标 → Settings）。
6. 可选的网页口令。tailnet 只有你自己时，面板的开放程度就等于你的设备。共享 tailnet、在局域网开放 web（`JOB_RADAR_WEB_BIND`）或前面加了反向代理时，请设口令：

```bash
pnpm web:password            # 输入两次，打印 JOB_RADAR_WEB_PASSWORD_HASH=...
# 把这一行贴进 .env，然后
docker compose up -d web
```

   之后手机会出现一次登录页（会话保持 30 天）；Mac 本机上的浏览器不需要口令。没设口令时，经 `tailscale serve` 打开的每一页都会有红色横幅提醒。细节、限制和其他变量见 [configuration.zh.md](configuration.zh.md#网页访问可选口令监听地址和端口)。

## 8. 日常检查

一条命令看全部：`pnpm run doctor`（逐项 ✅ / ⚠️ / ❌ 加修复提示，见 [deploy.zh.md](deploy.zh.md)）。下面是它背后的单项命令，排查时用：

```bash
docker compose ps                                   # 四个服务的状态和 health
docker compose logs --tail 50 runner                # 最近的 runner 日志
docker inspect --format '{{json .State.Health}}' job-radar-runner-1   # runner healthcheck 的最近几次结果
ls -lh data/backups                                 # 备份文件（见 backup-restore.zh.md）
```

runner healthcheck：容器里每 30 秒执行一次 `node dist/healthcheck.mjs`，读数据库里最新的 runner 心跳；超过 `RUNNER_HEALTH_MAX_AGE_SECONDS`（默认 120 秒，是心跳间隔的 4 倍）没有新心跳，或者连不上数据库，就记一次失败，连续 3 次后容器状态变成 `unhealthy`。

注意：`unhealthy` 只是状态，Docker 的 `restart: unless-stopped` 只在进程退出时重启，不会因为 unhealthy 重启。看到 runner 是 `unhealthy`：先 `docker compose logs --tail 100 runner` 看原因，再 `docker compose restart runner`。

日志轮转：所有服务用 json-file 驱动，每个服务最多 `LOG_MAX_FILE`（默认 5）个文件、每个最大 `LOG_MAX_SIZE`（默认 10m），在 `.env` 里可以改。

AI worker 的日常检查：`/sources` 页的 AI worker 卡片（心跳、排队的 AI 请求数、最近一次 `run_ai` 的结果）；命令行 `launchctl print gui/$(id -u)/io.jobradar.ai-worker`。日志在 `data/logs/`，worker 按大小自动轮转（见 6b 节），不用手动清。

Docker 的磁盘占用：`scripts/ops/deploy.sh` 每次部署后把构建缓存清到 `schedule.yaml: deploy.build_cache_keep_gb`（默认 5 GB）并删悬空镜像，从不碰数据卷。手动看占用：`docker system df`。如果内置盘不大，把 Docker 数据目录搬到外置盘。

## 9. 数据在哪里

- 数据库在 Docker 的命名卷 `jobradar-pg` 里，位于 Docker Desktop 的磁盘镜像中。镜像在 Docker Desktop 设置的数据目录（`DataFolder`）里：默认在内置盘 `~/Library/Containers/com.docker.docker` 下；内置盘不大的话可以把它搬到外置盘（doctor 的 `disk.docker_location` 检查它在不在项目所在的卷上）。无论在哪，磁盘镜像都不是普通文件，`data/backups/` 里的 pg_dump 才是数据的常规副本，见 [backup-restore.zh.md](backup-restore.zh.md)。
- ai-worker 的日志在 `data/logs/`（6b 节）。
- 卷名是 `jobradar-pg`，除非 `.env` 设了 `JOBRADAR_PG_VOLUME`（只有第二个实例才设，见 [multiple-instances.zh.md](multiple-instances.zh.md)）；已有安装永远不要改它。
- 永远不要执行 `docker compose down -v`：`-v` 会删除数据库卷。停服务用 `docker compose stop` 或 `pnpm stack:down`（不带 `-v`）。

## 10. Linux

栈在 Linux 上一样运行（CI 的 `linux-smoke` 任务在 Ubuntu 24.04 上从零测试）。与 Mac 的不同：

- **Docker**：Docker Engine 加 compose 插件（`docker compose version`）。Docker 由 systemd 开机启动（`sudo systemctl enable --now docker`）；容器自己重启（`restart: unless-stopped`）。没有 Docker Desktop、`pmset` 和 launchd：第 1 到 3 节不适用。
- **文件属主**：web 和 runner 会写 `data/`（权限 0600 的配置文件、备份、导出）。Linux 上容器以 `PUID:PGID`（默认 `1000:1000`）运行；第一次 `docker compose up` 之前，把它们设成拥有这份检出的用户：

```bash
# .env.example 里已经有空的 PUID= 和 PGID= 两行：把它们填上（不要再追加第二对）
sed -i.bak -e "s/^PUID=.*/PUID=$(id -u)/" -e "s/^PGID=.*/PGID=$(id -g)/" .env && rm .env.bak
mkdir -p data/config data/profile data/backups data/exports data/logs .auth   # 以这个用户创建，不要用 root
docker compose up -d --build
```

  如果这些目录已经被 Docker 以 root 身份创建，修一次即可：`sudo chown -R "$(id -u):$(id -g)" data .auth`
  （升级旧安装见 [upgrade.zh.md](upgrade.zh.md#linux从容器以-root-运行的旧版本升级)）。`pnpm run doctor` 会提醒不属于 `PUID` 的文件（`data.ownership`）。
- **AI worker（第 6b 节）**：`scripts/ops/install-ai-worker.sh` 装的是 systemd **用户**单元 `~/.config/systemd/user/job-radar-ai-worker.service`（权限 0600：里面有 `DATABASE_URL`），而不是 launchd agent：

```bash
scripts/ops/install-ai-worker.sh --dry-run    # 打印单元（密码已遮盖），不做任何改动
scripts/ops/install-ai-worker.sh              # 构建 HEAD 的发布目录，写单元，daemon-reload、enable、start
systemctl --user status job-radar-ai-worker.service
journalctl --user -u job-radar-ai-worker.service -n 50     # 启动失败；worker 自己的日志在 data/logs/
loginctl enable-linger "$USER"                # 退出登录后也保持运行（有的系统需要 sudo）
scripts/ops/uninstall-ai-worker.sh            # disable --now 并删除单元
```

  和 macOS 一样，先启动数据库（`docker compose up -d`）；worker 从发布目录运行（单元的 `WorkingDirectory=`；`TimeoutStopSec` 是 `deploy.ai_worker_stop_timeout_seconds`）。
  没有 systemd 用户会话（容器里、没有 systemd 的 WSL）时，脚本会说明情况和原因，并且不做改动。从 `sudo`、`su` 或 cron 里运行时缺 `XDG_RUNTIME_DIR`：请用这个用户正常登录后再运行。SSH 到服务器而这个用户没有会话管理器时：`sudo loginctl enable-linger <用户>`，重新登录。其余情况用你自己的进程管理器运行 `pnpm ai-worker`。卸载脚本停不掉某个单元文件时会保留它并说明原因。`JOB_RADAR_SERVICE_MANAGER=systemd|launchd|none` 可以覆盖自动判断。要手动安装，模板在 `scripts/ops/systemd/job-radar-ai-worker.service`。Linux 上 doctor 的 `aiworker.launchd` 检查读取 `systemctl --user show`。
- **备份**在 runner 容器里运行（宿主机不需要定时器）；见 [backup-restore.zh.md](backup-restore.zh.md)。
- **手机访问**：Tailscale 用法相同（`tailscale serve --bg 3000`）。别人也能访问的服务器上，请设网页口令（第 7 节第 6 步）。
