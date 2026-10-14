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

输出是 12 个步骤和每一步要执行的命令；如果有条件现在不满足（比如不在 main 分支、有未提交的改动），会用 `⚠ 实际运行会在这里停下` 标出来。确认没问题后：

```bash
scripts/ops/deploy.sh
```

在**主 checkout** 里运行（不要在 worktree 或 feature 分支里；不带 `--ref` 时跟随 `main`，带 `--ref <tag>` 时检出该 tag 并停在 detached HEAD；ai-worker 从 `data/releases/ai-worker/` 下所部署提交的发布目录运行，见下面“ai-worker 从发布目录运行”）。脚本按顺序做，**任何一步失败就停下**，并告诉你是第几步、为什么、怎么办；已完成的步骤不会回滚，修好后重新运行即可（每一步都是幂等的）：

| 步骤 | 做什么 | 失败时通常是 |
|---|---|---|
| 1 preflight | 终端没有设 `tostop`（否则后台输出会被暂停）；取部署锁（同一时间只有一次部署，见下面“同一时间只有一次部署”），并删除以前被中断的部署留在 `data/build/` 里的构建上下文；git / docker / node / pnpm 都在，Docker 在运行；已跟踪的文件没有未提交的改动（所有模式都查，`--skip-pull` 也一样，见“构建上下文和干净的工作树”）；外接卷没有重复挂载 | Docker Desktop 没起来；有未提交的改动；另一次部署持有锁；设了 `stty tostop`（运行 `stty -tostop`） |
| 2 pull | 不带 `--ref`：当前在 main，`git fetch` 后快进到 `origin/main`。带 `--ref <tag>`：fetch 该 tag（或分支），在检出目录移动之前拒绝 ai-worker 不能从发布目录运行的版本（见 [upgrade.zh.md](upgrade.zh.md#downgrade-pre-release-dir)），然后检出。然后固定要部署的提交：后面每一步都用它；从 install 到 ai-worker，HEAD 移动了或已跟踪的文件变了，那一步就停下 | 在别的分支（不带 `--ref` 时）；本地有没推送的提交（分叉）；`checkout moved during deploy`（部署期间有别的 git 命令动了检出目录）；`--ref` 指向发布目录之前的版本 |
| 3 install | `pnpm install --frozen-lockfile` | 网络 |
| 4 config | 建 `data/config`、`data/profile`、`data/backups`、`data/exports`；`pnpm config:init`（把用户配置目录 `data/config` 缺的文件从默认配置 `config/` 复制过去，从不覆盖；第一次部署时用户目录是空的，于是整份复制）；`pnpm config:migrate --write`（`config_version` 升级，原文件备份到 `data/config/.backup/<时间>/`）；`pnpm config:check`（两层都查，并写出每份配置读的是哪一层）；检查 `.env`；`docker compose config` | YAML 写错了（报错会指出文件和字段）；某个文件的 `config_version` 比代码新（代码回退了） |
| 5 backup | db 已经在运行就先做一份 `pre-deploy` 备份（第一次部署跳过） | 备份失败时不继续升级 |
| 6 build | 把第 2 步固定的提交用 `git archive` 解到 `data/build/<提交>-<pid>/`，以这个目录为构建上下文（`JOB_RADAR_BUILD_CONTEXT`）运行 `docker compose -p job-radar build`。镜像里正好是已提交的文件，包括 `config/` 里的出厂默认配置 | 磁盘满 |
| 7 release | `scripts/ops/prepare-release.sh <提交> --root <检出目录>`：构建 ai-worker 的发布目录 `data/releases/ai-worker/<提交>/`（该提交的 `git archive` 加生产依赖，只读）；已经存在且完整就跳过 | 网络或磁盘（安装依赖） |
| 8 up | 先 `pnpm ops:drain`：有轮次正在运行就等它结束（最长 `schedule.yaml: deploy.drain_timeout_seconds`，900 秒），因为重建 runner 会打断它。然后 `docker compose up -d --wait`：db / web / runner / jobspy 都要变成 healthy（最长 300 秒） | 某个服务起不来：脚本会列出 `docker compose ps` 和看日志的命令。等完了轮次还在跑只打印警告（`pnpm ops:drain` 退出码 1），没能检查（退出码 3：配置或数据库出错，或某个查询卡住）也只打印警告：部署继续，runner 启动时的补跑会重跑那个定时时段 |
| 9 migrate | `pnpm migrate:run`（runner 启动时也会自动迁移，这里是确认；已是最新则什么都不做）。有待执行的迁移时先做一份 `premigrate` 备份（数据库加配置压缩包），备份失败就不迁移（`schedule.yaml` 的 `backup.pre_migrate`） | 迁移 SQL 有问题；迁移前备份失败 |
| 10 ai-worker | `scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<提交>`：把 ai-worker（macOS 上是 launchd agent，Linux 上是 systemd 用户单元 `job-radar-ai-worker.service`）切换到第 7 步的发布目录；新 worker 拿不出证据时回滚到上一个（见下面“ai-worker 从发布目录运行”）。它正在处理的 AI 请求（比如给一整轮打分的 `run_ai`）不会丢：回到队列，重启后接着跑（见下面“被重启打断的工作”） | 输出以 `not changed:`（什么都没动）、`rolled back:`（上一个 worker 又在运行）或 `ROLLBACK FAILED:`（按消息处理）开头；`claude` / `codex` 不在 PATH 里 |
| 11 prune | 先释放部署锁、删除第 6 步的构建上下文。然后清理 Docker：构建缓存按最近使用只留 `schedule.yaml: deploy.build_cache_keep_gb`（`docker builder prune -f --max-used-space 5gb`），删悬空镜像（`docker image prune -f`，不带 `-a`）。从不碰数据卷，不删正在使用的镜像 | 不会让部署失败：命令出错只打印 ⚠ 继续（比如 Docker 太旧不认 `--max-used-space`） |
| 12 doctor | 等 20 秒让心跳到位，再运行 `pnpm run doctor` | 见下 |

选项：`--skip-pull`（不动 git，按当前代码部署，回滚用）、`--ref <标签|分支>`（部署 `v2.0.0` 这样的发布标签而不是 `main`，见 [upgrade.zh.md](upgrade.zh.md)）、`--no-backup`、`--no-prune`（跳过第 11 步的 Docker 清理）、`--no-ai-worker`（跳过第 7、10 步）、`--no-drain`（第 8 步不等正在运行的轮次）、`--drain-timeout 秒`（代替 `deploy.drain_timeout_seconds`）、`--branch`、`--remote`、`--wait-timeout 秒`、`--settle 秒`；`--help` 看全部。

第 7、10 步的设置在 `schedule.yaml` 的 `deploy` 块（只有部署脚本读它，改完下次部署生效）。部署脚本和备份脚本读 `schedule.yaml` 时和代码一样：先读用户配置 `data/config/schedule.yaml`，没有才读默认的 `config/schedule.yaml`：

| 键 | 默认 | 含义 |
|---|---|---|
| `deploy.prune_build_cache` | true | 部署后清理 Docker 构建缓存 |
| `deploy.build_cache_keep_gb` | 5 | 按最近使用保留这么多 GB 的构建缓存，下次构建仍然快；0 = 清掉全部未使用的构建缓存 |
| `deploy.prune_dangling_images` | true | 删除悬空镜像（旧构建留下的、没有标签的镜像） |
| `deploy.drain_timeout_seconds` | 900 | 第 8 步重建容器前，最多等这么多秒让正在运行的轮次结束；0 = 不等 |
| `deploy.drain_poll_seconds` | 10 | 第 8 步等待时多久看一次 |
| `deploy.ai_worker_releases_keep` | 3 | 切换后保留的 ai-worker 发布目录个数，含当前安装的和上一个（至少 2）。出厂文件里没有，要改就自己加 |
| `deploy.ai_worker_stop_timeout_seconds` | 60 | launchd / systemd 发 SIGTERM 后最多等多久再强杀 ai-worker（`ExitTimeOut`、`TimeoutStopSec`）；至少 10，要大于 `ai.yaml: host_worker.shutdown_grace_seconds`。出厂文件里没有 |
| `deploy.ai_worker_swap_timeout_seconds` | 120 | worker 切换中每一段等待的上限（旧 worker 退出、新 worker 拿出证据，回滚时同样）；至少 `ai_worker_stop_timeout_seconds` + 10。出厂文件里没有 |

### 构建上下文和干净的工作树

镜像从要部署的提交构建，而不是从工作树构建：第 6 步把这个提交用 `git archive` 解到 `data/build/<提交>-<pid>/`，从那里构建。被 git 忽略的文件（`.env`、`data/`、`*.local.yaml`）、未跟踪的文件、本地改动、只改了权限的文件、指向仓库外的符号链接，都进不了镜像。`config/` 里的出厂默认配置是 web、runner 镜像的一部分（`/app/config`，只读，属于 root），上面不挂载任何东西，所以 `config/` 的改动只有经过部署才会到容器里。

配置步骤和迁移是从检出目录本身运行的，所以检出目录必须和那个提交一致：所有模式（包括 `--skip-pull`）在已跟踪的文件有未提交的改动时都拒绝开始（`git status --porcelain --untracked-files=no`；未跟踪的文件不影响）；`git status` 本身出错（例如 `.git/index` 损坏）时同样拒绝：git 答不上来，绝不算干净。从第 2 步起，部署期间 HEAD 移动了或已跟踪的文件变了，步骤就以 `checkout moved during deploy` 停下；这些核对里 git 出错时以 `cannot check the checkout` 停下。

部署结束时删除构建上下文目录。部署被直接杀掉（比如 `kill -9`）时目录会留下，下一次部署拿到锁之后删除它。

### 同一时间只有一次部署：部署锁

第 1 步取锁 `data/releases/ai-worker/.lock/`（一个目录；`owner` 记着持有它的进程和主机，`inflight/` 里每个在锁下工作的脚本有一条记录）。这时再启动的部署在第 1 步以退出码 1 停下，什么都不改，并打印谁持有锁、有哪些记录、怎么核对和清除。锁在 Docker 清理（第 11 步）之前释放，部署提前停下时也会释放。发布步骤和 ai-worker 步骤在同一把锁下运行（重入），手动运行 `install-ai-worker.sh` 也会取这把锁。如果连锁都建不起来（磁盘满、`data/releases/` 没有写权限），第 1 步以 `could not initialise the deploy lock` 停下，删掉自己刚建的东西，不说是别的部署占着锁；如果连删除也失败，这个建了一半的锁会留下，并像其他留下的锁一样打印报告（按报告清除它，再重试）。如果正好在这次部署取锁的那一刻，另一次部署释放了锁，第 1 步会说明这一点，重新运行即可。释放时，部署会说明保留锁的原因（还有记录、owner 文件损坏、有意外的条目）；如果锁已经属于另一次运行，或者已经不在了，它会直接说明，不打印清除命令（不要删除另一次部署持有的锁）。

锁从不被自动接管。只有两种情况会留下锁：部署被 `kill -9` 杀掉（它的退出处理没能运行）；或者部署没法确认它启动的东西都已结束（这时它以 1 退出，消息是 “descendant exit not confirmed; lock left in place”）。清除之前，先用消息里打印的 `ps` 命令确认它启动的东西（构建、`pnpm install`、迁移、配置写入、drain）都已不在，再执行它打印的 `rm -rf data/releases/ai-worker/.lock`，然后重新部署。

### ai-worker 从发布目录运行

ai-worker 从不直接从检出目录运行：`git pull` 或切分支会在它运行时换掉它的代码。每次部署构建
`data/releases/ai-worker/<提交>/`（第 7 步，`scripts/ops/prepare-release.sh`）：该提交的文件加生产依赖，设为只读。服务定义
（plist 或 systemd 单元）里只有绝对路径：代码和 `config/` 来自发布目录；`.env`、`data/config`、`data/profile`、`data/logs`
来自主 checkout。

第 10 步用 `scripts/ops/install-ai-worker.sh --release <目录>` 切换 worker。它先把已安装的定义复制到
`data/run/ai-worker-swap-backup/`，停掉旧 worker 并等它退出，写入并启动新定义，再最多等
`deploy.ai_worker_swap_timeout_seconds` 拿到新 worker 的证据（一个持有数据库锁的新进程，以及比切换更新的心跳）。拿不到就放回旧定义、
启动它，并同样等它的证据。结果的第一行说明发生了什么：

- `installed: … runs <提交> from <目录>`：完成。超出 `deploy.ai_worker_releases_keep` 的旧发布目录被删除，备份也一起删除。
- `not changed: …`（退出码 1）：动手之前就拒绝了（锁被占用、有未解决的备份、有多个 worker 定义、读不到数据库时钟）。
- `rolled back: …`（退出码 1）：新 worker 没拿出证据，上一个又在运行。看原因和 `data/logs/ai-worker.err.log`，修好后重新部署。
- `ROLLBACK FAILED: …`（退出码 1）：没能恢复到之前的状态。消息说明现在装的是什么；备份留在 `data/run/ai-worker-swap-backup/`，
  解决之前下一次安装会拒绝（见 [upgrade.zh.md](upgrade.zh.md#unresolved-switch-backup)）。

`scripts/ops/install-ai-worker.sh --print-release` 打印已安装 worker 的发布目录（退出码 0）；没有安装 worker（或者只装在旧标签 `de.jobradar.ai-worker` 下）时退出码 3；装了但不是从发布目录运行
（以前版本的安装）时退出码 4；定义读不了或者有多个时退出码 1。切换过程中被 Ctrl-C、TERM 或 HUP 打断时，脚本先回滚，再以 130、143 或 129 退出。

### 中断部署

Ctrl-C、关掉终端、`kill <pid>` 都不会把某一步从中间切断。每一步的命令都在自己的进程组里运行，终端的信号到不了它：正在运行的那一步先跑完，不再开始下一步，释放锁、删除构建上下文，脚本以 130（Ctrl-C，INT）、143（TERM）或 129（HUP，终端关了）退出。停下时它会打印当前这一步和它的进程组：

```text
stopping after this step (build: build the images from the target commit, process group 12345); to abort it now: kill -TERM -12345
```

想立刻中止正在运行的这一步，自己发这条 `kill -TERM -<组号>`：这一步就算失败，部署照样等这个组清空后才清理、释放锁。这样停下的部署，和某一步失败时一样（已完成的步骤不回滚）；再运行一次脚本就能做完。

终端关掉之后，往终端写输出的命令可能出错，让这一步失败。生产部署建议在 `tmux` 里运行（或者 `nohup scripts/ops/deploy.sh > deploy.log 2>&1 &`），这样 ssh 断线不会让它停下。

### 被重启打断的工作

部署（或者崩溃、`launchctl kickstart`）可能在 runner 或 ai-worker 干活时重启它们。不会有工作被悄悄丢掉：

- **控制请求**（`run_ai`、打分、翻译、重打分、兴趣建议）：被重启打断的请求回到队列（pending），进程起来后重新执行。打分和推送从断开的地方接着做：已有分数的岗位不会再打分，已推送的岗位不会再推送。同一个请求被打断超过 `ai.yaml: host_worker.requeue_interrupted_max` 次（3）就改为失败，免得一个会把进程搞崩的请求无限循环；设为 0 恢复旧行为（立刻失败）。runner 也用这个值。有两类请求不重新排队而是直接失败，还需要的话再点一次：“测试”按钮，和手动“立即采集”（下面的补跑已经会重跑采集，再排一个只会采两遍）。
- **轮次**：正在运行的轮次没法从中间接着跑，所以第 8 步先等它（见上）。如果还是被打断了（等待超时、`--no-drain`、崩溃），这一轮记为失败；runner 启动时的补跑不把它算作“已经跑过”，它所属的定时时段会马上重跑。只重跑一次：如果重跑的这一轮又被打断（比如一轮本身会把 runner 搞崩），它就算“跑过”，崩溃不会变成反复的全量采集。

### 只能有一个 ai-worker

ai-worker 运行期间一直持有一个 Postgres 会话级 advisory lock；第二个会以退出码 3 退出（不带 `--once` 时先等 `ai.yaml: host_worker.already_running_wait_seconds`，60 秒），所以同一个请求不会跑两次。两个局限：

- 这把锁需要真正的会话。如果 `DATABASE_URL` 经过事务模式的连接池（例如 PgBouncer `pool_mode = transaction`），锁就不跟 worker 的连接绑定，起不到保护作用：让 ai-worker 直连 Postgres，或者用会话模式的池。compose 的配置是直连。
- 数据库重启时所有锁都没了。worker 在下一次心跳（`host_worker.heartbeat_seconds`）时重新拿锁；如果恰好在这个空档里启动了第二个 worker，锁归它，它会把第一个正在执行的请求放回队列（于是可能跑两次），第一个在下一次心跳时退出。只有在数据库重启期间手动再起一个 worker 才会碰到。

第 10 步装的 ai-worker 的日志位置：

- **限制**：launchd 自己打不开外接卷上的文件。plist 的 `StandardOutPath` / `StandardErrorPath` 指向外接卷时，任务根本起不来（`launchctl print` 显示 `last exit code = 78: EX_CONFIG`；用 `/bin/sh` 和 node 都一样，在 macOS 上实测）。`WorkingDirectory` 和程序文件在外接卷上没问题，launchd 启动的 node 进程也能往外接卷写文件。所以**不要**把 plist 的这两个路径改到外接卷上。
- ai-worker 自己把输出写到 `data/logs/ai-worker.out.log` / `ai-worker.err.log`（项目所在的卷），超过 `ai.yaml: host_worker.log_max_mb`（10 MB）复制后截断，留 `log_keep`（3）份 `.1`…`.3`。
- launchd 的输出文件留在内置盘：`~/Library/Logs/job-radar/ai-worker.launchd.log`，只接住 worker 打开自己的日志之前的输出和崩溃；同样按大小轮转，轮转出来的旧副本放到 `data/logs/`，内置盘上始终只有这一个小文件。
- 更早版本安装的 ai-worker 还把日志写在 `~/Library/Logs/job-radar/ai-worker.{out,err}.log`（doctor 的 `aiworker.launchd` 会 ⚠️ 提示）：重新运行 `scripts/ops/install-ai-worker.sh`（或 `scripts/ops/deploy.sh`），旧日志会一次性搬到 `data/logs/ai-worker.{out,err}.before-upgrade.log`。

退出码：`0` 部署完成且 doctor 没有问题（或只有 ⚠️）；`1` 某一步失败（包括 ai-worker 切换），或者另一次部署持有锁，或者 doctor 自己没能运行；`2` 部署完成，但 doctor 报告了 ❌（按它的「怎么办」处理，处理完再运行 `pnpm run doctor`）；`130`、`143`、`129` 部署被中断（INT、TERM、HUP，见《中断部署》）。

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
| `data.mcp` | 只读 MCP 服务是否打开（`mcp.yaml: enabled`）、开了哪些工具；默认关闭 | ⚠️ `mcp.yaml` 读不出来：`pnpm config:check`。见 [mcp.zh.md](mcp.zh.md) |
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
| `ai.quota` | Job Radar 自己对订阅 CLI 的用量上限（`ai.yaml: quota_guard`）：每个 CLI 在滚动窗口内的调用数对比 `hard_requests`。只统计 Job Radar 自己的调用，看不到账户的真实用量 | ⚠️ 某个 CLI 的窗口满了，或它报告了限制正在冷却：到显示的时间会自动恢复；如果碍事，在设置 → AI → 限额里调高（`pnpm ai:usage-stats` 打印你自己的数据） |
| `config.layers` | 用户配置目录 `data/config` 存在且可写；列出覆盖了的 `shipped` 文件、版本落后（要迁移）的文件、还在读默认配置的 `user` 文件 | ❌ 目录不存在或不可写（`pnpm config:init`；查挂载）；❌ 某个文件的 `config_version` 比代码新（代码回退了：升级代码或从 `data/config/.backup/` 恢复）；⚠️ 覆盖了 `models.yaml` / `pipeline.yaml`：产品更新这些文件的内容不会生效，想跟随就删掉 `data/config` 里那份；⚠️ 版本落后：`pnpm config:migrate` 看改动，`--write` 写回 |
| `config.shipped` | 每个运行中的进程（web、runner，以及 `execution: host` 时的 ai-worker）报告的出厂配置标识，并核对每份报告是否来自现在运行的进程：运行中的容器（主机名和启动时间），或 ai-worker 服务的 PID；ai-worker 的配置来自本检出目录下一个提交等于 HEAD 的发布目录。见 [configuration.zh.md](configuration.zh.md#出厂配置标识) | ⚠️ ai-worker 不是从 `data/releases/ai-worker/` 运行（由发布目录之前的版本安装）：部署，或运行 `scripts/ops/install-ai-worker.sh`；⚠️ 它的发布不是 HEAD：只回滚 worker 后是预期的，否则是部署在第 10 步之前停下了：重新部署；⚠️ 没有报告、报告来自之前的容器或进程、或 launchd / systemd 给不出 PID 无法核对：部署或重启后等一分钟再运行；否则在该进程日志里找 "could not report the shipped config"。⚠️ 容器的 `/app/config` 上有挂载（会挡住镜像里的出厂配置，通常是旧的 `compose.override.yaml`）：去掉挂载再部署。连不上数据库时跳过报告的核对，挂载检查照样运行（它只需要 Docker） |
| `host.power` | `pmset` 里 autorestart 是 1、sleep 是 0 | ⚠️ 没设置：host-setup 第 3 节 |
| `ops.releases_lock` | 没有遗留的部署锁 `data/releases/ai-worker/.lock`。锁属于正在运行这个 doctor 的部署（`JOB_RADAR_RELEASES_LOCK_TOKEN` 里是同一个 token）时为 ✅ | ⚠️ 锁存在：列出持有者（pid、主机、持有多久）、每条在途记录及其进程是否还在、查找被杀部署遗留进程的 `ps` 命令，以及清除它的 `rm -rf`（见上面“同一时间只有一次部署”）。从不显示 token |
| `ops.ai_worker_swap_backup` | 没有未解决的 worker 切换备份 `data/run/ai-worker-swap-backup/` | ⚠️ 一次切换失败且回滚没完成；解决之前下一次安装会拒绝：[upgrade.zh.md](upgrade.zh.md#unresolved-switch-backup) |

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
| `doctor.shipped_report_skew_seconds` | 2 | `config.shipped`：报告（数据库时钟）最多可以比容器启动时间（Docker 时钟）早多少秒。出厂文件里没有这一项，要改就自己加上 |
| `doctor.linkedin_auth_dir` | `.auth` | 登录态目录（相对项目目录） |

数据库密码：用 `scripts/ops/deploy.sh`（或运行 `pnpm config:init`）做首次安装（`.env` 里没有 `POSTGRES_PASSWORD`，也还没有 `jobradar-pg` 卷）时，`pnpm config:init` 会在创建数据库之前往 `.env` 写一个随机密码（权限 0600，不打印），不再用众所周知的默认值。已有的数据库保留创建时的密码，所以那里什么都不会改；以后要改，先在数据库里用 `ALTER USER`，再更新 `.env`。`.env` 请自己备份：它不在任何备份里。

其他位置：数据库连接用 `DATABASE_URL`（没设就按 `.env` 的 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `DB_HOST_PORT` 拼），备份目录用 `RUNNER_BACKUP_DIR`（默认 `data/backups`，所以要在项目目录里运行）。

## 4. 升级

从 2.0.1 或更早的版本第一次升级到出厂配置打进镜像的版本，要多做三条命令，见 [upgrade.zh.md](upgrade.zh.md)《跨过“出厂配置打进镜像”这一版的升级》。

```bash
scripts/ops/deploy.sh --dry-run     # 先看一眼
scripts/ops/deploy.sh --ref v2.0.0   # 用户推荐：发布标签（见 upgrade.zh.md）
scripts/ops/deploy.sh               # 或跟随 main：拉最新 main、备份、构建、重启、迁移、重启 ai-worker、清理 Docker 构建缓存、doctor
```

升级前脚本会自动做一份 `jobradar-manual-…-pre-deploy.dump` 备份（手动备份不会被自动清理）。升级期间 web 和 runner 会重启几十秒；轮次正在运行时重启 runner 会让这一轮中断，下次启动时 `catch_up` 会补跑。想避开轮次：早轮 07:00、晚轮 17:00（工作日）、周末 09:00，在两轮之间升级。

升级后跑一次 `pnpm run doctor`，确认没有新的 ❌。

### 配置分层之后

- 线上配置是 `data/config/`（不进 git），网页只写这里；`config/` 是随代码发布的默认配置，打进 web、runner 镜像，所以它的改动随构建并重启容器的那次部署（第 6、8 步）生效，单独 `git pull` 不会生效。默认配置变了也只影响用户目录里**没有**的文件（`models.yaml`、`pipeline.yaml` 这类 `shipped` 文件，除非你覆盖了它们）。所以主 checkout 不会再因为网页保存而变脏，部署也不会再因此拒绝 pull。
- **从配置分层之前的版本升级**：第 4 步发现 `data/config` 是空的，`pnpm config:init` 把当时 `config/` 里的全部 `user` 类文件复制过去（和 `pnpm config:init --from config` 结果相同：此时默认配置就是旧的线上配置）。第 4 步之前已经在网页上保存、但还没提交的改动在 `config/` 里（checkout 是脏的，第 2 步会拒绝），先提交再部署。第 4 步到第 8 步之间（旧容器还在跑、还写 `config/`）不要在网页上保存设置。
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
