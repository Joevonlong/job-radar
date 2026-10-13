# 升级、回滚与卸载

[English](upgrade.md) | [中文](upgrade.zh.md)

Job Radar 从一个 git 检出目录运行。发布版本是签名的 git 标签 `vX.Y.Z`（见[更新日志](../CHANGELOG.md)）。如果你只是使用它，**请停留在发布标签上**，从一个标签升级到下一个；`main` 是开发分支，两次发布之间可能变化。

## 升级到某个发布版本

```bash
git status                                   # 必须是干净的（data/ 和 .env 被 git 忽略，没有关系）
scripts/ops/deploy.sh --ref v2.0.0 --dry-run # 先看它会做什么，不改任何东西
scripts/ops/deploy.sh --ref v2.0.0           # 正式升级
```

把 `v2.0.0` 换成你想要的版本（`git fetch --tags && git tag --list 'v*'` 列出所有版本）。先读那个版本的更新日志：它会写明你是否需要手动做什么。

`--ref` 可以是标签或分支。检出会停在那个提交上（对标签来说 git 称之为 detached HEAD，这是正常的）。不加 `--ref` 时脚本跟随 `main`。

部署默认不验证签名。加 `--verify` 会先对标签运行 `git verify-tag`，无效就停止。它用的是随仓库发布的维护者公钥 [`signing-key.pub`](signing-key.pub)（`allowed_signers` 格式；指纹 `SHA256:HHRRfExpbUjcK0/pdc5E1qf94ogkREVkt9+1VP58JQc`，[SECURITY.md](../SECURITY.md) 里也有）；你自己用 `git config gpg.ssh.allowedSignersFile` 设置的公钥列表优先。有签名密钥时发布会签名，见 [RELEASING.md](../RELEASING.md)。手动检查：`git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=docs/signing-key.pub tag -v v2.0.0`。

### 部署脚本做了什么

按顺序执行，遇到第一个失败的步骤就停下：

1. **预检**：取部署锁（同一时间只有一次部署），检查 git、docker、node、pnpm 已安装、Docker 正在运行；已跟踪的文件有未提交的改动时拒绝运行（`--skip-pull` 也一样）。
2. **检出**：获取标签和分支并切换到 `--ref`。从这里开始，部署只用这个提交。
3. 按锁文件**安装**依赖。
4. **配置**：创建 `data/` 目录，复制你还没有的配置文件，迁移格式有变化的配置文件（原件保存在 `data/config/.backup/`）。
5. **备份**：数据库在运行时先做一个 `pre-deploy` 备份到 `data/backups/`。备份失败会中止升级。
6. 从这个提交的 `git archive` **构建**镜像：镜像里正好是已提交的文件，包括 `config/` 里的出厂默认配置，检出目录里的其他东西都进不去。
7. **排空并重启**：有限时间内等待正在运行的周期结束，然后重建容器并等待它们健康。
8. **迁移**数据库（runner 启动时也会做）。有待执行的迁移时会先做一份 `premigrate` 备份，备份失败就不迁移。
9. **ai-worker**：重装或重启主机 AI worker 服务：macOS 上是 launchd 代理，Linux 上是 systemd 用户单元 `job-radar-ai-worker.service`（没有 systemd 用户管理器时不安装任何东西，脚本会说明）。
10. **清理**：释放部署锁，然后清理 Docker 构建缓存和悬空镜像（不动数据卷）。
11. **doctor**：`pnpm run doctor` 报告需要关注的事项。

按 Ctrl-C 或关掉终端时，正在运行的那一步会先跑完再停（退出码 130、143 或 129）；再运行一次脚本就能完成升级。细节见 [deploy.zh.md](deploy.zh.md)《中断部署》。

细节和选项见 [deploy.zh.md](deploy.zh.md)。

### Linux：从容器以 root 运行的旧版本升级

web、runner 和 jobspy 容器现在以普通用户运行，即 `.env` 里的 `PUID:PGID`（默认 `1000:1000`），不再是 root。旧版本写进
`data/` 和 `.auth/` 的文件可能属于 root，容器就写不了它们了。升级前做一次（在项目目录里）：

```bash
id -u; id -g                                  # 你的 id
# 写进 .env：  PUID=<id -u>  PGID=<id -g>
sudo chown -R "$(id -u):$(id -g)" data .auth  # .auth 只有登录过 LinkedIn 才有
```

然后按上面的步骤升级。升级后 `pnpm run doctor` 会检查（`data.ownership`：`data/` 或 `.auth/` 下有不属于 `PUID` 的东西就提醒）。
macOS 不受影响（Docker Desktop 会映射文件归属）。

### 跨过“出厂配置打进镜像”这一版的升级

从 2.0.1 之后的第一个版本起（它的更新日志里有这一条升级说明），出厂默认配置（`config/`）打进 web、runner 镜像，不再从检出目录挂载；`scripts/ops/deploy.sh` 从它要部署的提交的 `git archive` 构建镜像。从 2.0.1 或更早的版本第一次升级上来，在项目目录里执行三条命令：

```bash
docker compose -p job-radar stop web runner
git pull                                # 或者升级到某个发布版本：git fetch --tags && git checkout --detach <标签>
scripts/ops/deploy.sh --skip-pull
```

`job-radar` 是默认的 compose 项目名；如果你的 `.env` 设置了 `COMPOSE_PROJECT_NAME`，换成那个名字。

为什么要多这几步：旧容器通过挂载直接读检出目录里的 `config/`。它们还在运行时更新检出目录，就会让旧代码读到新的默认配置（以前每次升级都有这个窗口）；先停掉 web 和 runner 就没有这个窗口了。新的 `deploy.sh` 接着构建带配置的镜像，并去掉挂载重建容器。只运行 `docker compose up -d` 不够：它不会重建已有的镜像，而旧镜像并不带出厂配置（旧 runner 镜像里没有；旧 web 镜像里只有打包时顺带进去的一份不完整的副本），新的 compose 文件（没有挂载）会让它们在出厂配置不完整的情况下启动；它还会跳过配置步骤和迁移。从第一条命令到部署的第 7 步（几分钟，主要是构建），web 和 runner 一直停着；这段时间里到点的采集轮次，runner 启动后会补跑。

之后的升级不需要额外步骤。如果 `pnpm run doctor` 提示（`config.shipped`）有东西挂载在 `/app/config` 上，说明你自己的 compose 文件（比如 `compose.override.yaml`）还在挂载 `./config`：去掉这个挂载，再部署一次。

## 回滚

回到上一个标签：

```bash
scripts/ops/deploy.sh --ref <previous tag>
```

这只会回退代码。如果你离开的那个版本应用过数据库迁移，旧代码可能不认识新数据库；此时还要恢复升级时自动做的 `pre-deploy` 备份（这会覆盖数据库）：

```bash
ls -lh data/backups | grep pre-deploy
scripts/ops/restore.sh data/backups/<那个 pre-deploy 备份> --target jobradar --yes
```

恢复会把被替换的库保留为 `jobradar_before_restore_<时间戳>`，所以可以撤销；命令见 [backup-restore.zh.md](backup-restore.zh.md) 第 4 节。runner 在迁移前做的 `premigrate` 备份同样可用。

如果你离开的那个版本迁移过某个配置文件，旧代码会认为它“太新”（`pnpm run doctor` 的 `config.layers` 会提示）：把 `data/config/.backup/<时间戳>/` 里的原件复制回 `data/config/`。

更多见 [deploy.zh.md](deploy.zh.md)（第 5 节）和 [backup-restore.zh.md](backup-restore.zh.md)。要重新跟随 `main`：`git switch main && scripts/ops/deploy.sh`。

## 卸载

这会把 Job Radar 从机器上移除。**此操作不可逆：数据库、你的个人画像、配置和登录状态都会被删除。先做最后一次备份并复制到别处**（`scripts/ops/backup.sh`，再复制 `data/backups/`；如果以后可能回来，也保留 `data/profile/` 和 `data/config/`）。

在项目目录执行：

```bash
# 1. 主机 AI worker（macOS launchd 代理或 Linux systemd 用户单元）；--purge-logs 同时删除它的日志
scripts/ops/uninstall-ai-worker.sh --purge-logs

# 2. 停止并移除容器和网络
docker compose -p job-radar down

# 3. 删除数据库卷（所有已存的职位、申请和 AI 结果）——无法撤销
docker volume rm jobradar-pg

# 4. 删除本地数据、密钥和日志
rm -rf data .auth .env
rm -rf ~/Library/Logs/job-radar          # macOS：launchd 捕获的日志（如果还在）（Linux 上单元的输出在 journal 里）

# 5. 最后删除检出目录本身
cd .. && rm -rf job-radar
```

如果你改过 compose 项目名（`schedule.yaml` 的 `doctor.compose_project`），请用那个名字代替 `job-radar`。可选：`docker image prune` 删除构建出的镜像。为本项目设置过的登录自启 Docker、电源设置或 Tailscale（[host-setup.zh.md](host-setup.zh.md)）需要你手动撤销；`claude` / `codex` 的命令行登录属于你自己，会保留。
