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

1. **预检**：git、docker、node、pnpm 已安装，Docker 正在运行。
2. **检出**：获取标签和分支并切换到 `--ref`（检出目录不干净时拒绝运行）。
3. 按锁文件**安装**依赖。
4. **配置**：创建 `data/` 目录，复制你还没有的配置文件，迁移格式有变化的配置文件（原件保存在 `data/config/.backup/`）。
5. **备份**：数据库在运行时先做一个 `pre-deploy` 备份到 `data/backups/`。备份失败会中止升级。
6. **构建**镜像。
7. **排空并重启**：有限时间内等待正在运行的周期结束，然后重建容器并等待它们健康。
8. **清理** Docker 构建缓存和悬空镜像（不动数据卷）。
9. **迁移**数据库（runner 启动时也会做）。有待执行的迁移时会先做一份 `premigrate` 备份，备份失败就不迁移。
10. **ai-worker**：重装或重启主机 AI worker 服务：macOS 上是 launchd 代理，Linux 上是 systemd 用户单元 `job-radar-ai-worker.service`（没有 systemd 用户管理器时不安装任何东西，脚本会说明）。
11. **doctor**：`pnpm run doctor` 报告需要关注的事项。

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
