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
2. **检出**：获取标签和分支并切换到 `--ref`（发布目录之前的版本在检出目录移动之前就被拒绝，见[下面](#downgrade-pre-release-dir)）。从这里开始，部署只用这个提交。
3. 按锁文件**安装**依赖。
4. **配置**：创建 `data/` 目录。已有安装先预览配置迁移、在内存中校验新 schema 并检查 compose config，通过后才冻结设置写入，不补齐或迁移用户文件。真正的首装照常执行 `config:init`，不冻结。
5. **备份**：数据库在运行时先做一个 `pre-deploy` 备份到 `data/backups/`。备份失败会中止升级。
6. 从这个提交的 `git archive` **构建**镜像：镜像里正好是已提交的文件，包括 `config/` 里的出厂默认配置，检出目录里的其他东西都进不去。
7. **发布目录**：构建 ai-worker 的发布目录 `data/releases/ai-worker/<提交>/`（这个提交的文件加生产依赖，只读），worker 因此不会从一个之后会被 `git pull` 改掉的检出目录运行。
8. **排空并重启**：有限时间内等待正在运行的周期结束，然后重建容器并等待它们健康。
9. **迁移**数据库（runner 启动时也会做）。有待执行的迁移时会先做一份 `premigrate` 备份，备份失败就不迁移。
10. **ai-worker**：把主机 AI worker 服务（macOS 上是 launchd 代理，Linux 上是 systemd 用户单元 `job-radar-ai-worker.service`）切换到第 7 步的发布目录，新 worker 起不来时放回上一个（没有 systemd 用户管理器时不安装任何东西，脚本会说明）。
11. **config-write**：先用实例锁、心跳和配置报告确认目标服务 PID，再扫描宿主进程并比较实例锁持有者。只有持有者就是目标发布目录的服务 PID，或没有持有者也没有安装服务，并且进程扫描成功、没有其他 worker，才执行 `config:init` 和 `config:migrate --write`。重新规划检查跳过的写入，确认没有旧消费者后解除冻结。首装没有冻结 token，跳过门禁；不支持冻结协议的旧目标也跳过此步，沿用第 4 步写盘流程。
12. **清理**：释放部署锁，然后清理 Docker 构建缓存和悬空镜像（不动数据卷）。
13. **doctor**：`pnpm run doctor` 报告需要关注的事项。

按 Ctrl-C 或关掉终端时，正在运行的那一步会先跑完再停（退出码 130、143 或 129）；再运行一次脚本就能完成升级。细节见 [deploy.zh.md](deploy.zh.md)《中断部署》。

细节和选项见 [deploy.zh.md](deploy.zh.md)。

### 升级期间的设置

第 4 步先完成只读检查，再创建或接管冻结。之后直到第 11 步 `config-write`，只有认识冻结协议的 web 版本会拒绝设置、高级编辑器、个人资料和向导保存。首次部署本版本时，旧 web 一直运行到第 8 步，它的保存仍写旧格式文件，没有危害。`data/config/` 或 `data/profile/` 有 YAML、已有冻结标记、ai-worker 服务已安装、compose 有运行中的服务，任一项成立就是已有安装；真正的首装不冻结，并跳过 config-write 门禁。冻结时启动补文件会跳过且不抛错，缺失的 profile 在内存里读取 `config/profile.example/` 模板，不写盘。等待 `config-write` 生成文件时，读取方按当前安装状态选择默认值，包括已有安装的语言默认值。

标记 `data/config/.upgrade-freeze` 保存随机 token、目标提交和开始时间。只有显式带匹配的 `JOB_RADAR_UPGRADE_FREEZE_TOKEN` 的部署配置命令能绕过冻结；token 不打印，也不传给 web、runner 或 worker。所有写入都使用跨进程 `.write.lock` 短锁，多目录时先 config 后 profile；新鲜度和冻结检查都在锁内。同主机持有者除主机与 PID 外还记录进程代际（随机进程 ID 与启动时间）；PID 重用或 token 已不在本进程持有集合中时立即接管，活跃持有者不接管。其他主机或命名空间超过 300 秒才可接管。最多等待 10 秒后报 busy（可在 `schedule.yaml` 的 `deploy.config_write_lock_*` 调整），最终提交再次核对锁的所有权。

部署前先停止手工启动的旧 `pnpm ai-worker`。持有者是其他进程、看不见持有者、数据库不可达或服务仍指向旧发布目录时，不写配置、保留冻结并退出 2。`--no-ai-worker` 也检查持有者和服务定义的发布路径，只有目标服务 PID，或没有持有者且没有安装服务，才能写。`--settle 0` 不等待 receipt，采用同样的检查：服务必须指向目标发布目录，PID 必须持有实例锁且在检查前后不变，进程扫描必须排除其他 worker。写入失败或重新规划仍有待迁移文件也退出 2；一旦排除了旧消费者，即使需要手动重试也会删除标记。

没有实例锁持有者还不够：手工 worker 的数据库连接断开后，进程仍可能存活并重新取锁。macOS 和 Linux 都用 `ps -A -o pid=,args=` 扫描，只匹配 node/tsx 执行本安装（含发布目录）内的 `src/ai-worker/index.ts` 入口。相对路径通过进程 cwd 判断归属（macOS 用 `lsof -a -d cwd -p PID -Fn`，Linux 用 `/proc/PID/cwd`）；编辑器和其他检出目录的 worker 不计入，归属不明则阻止写入。除已确认目标服务 PID 外还有本安装的其他 worker 就阻止写入，并列出这些 PID；扫描失败也阻止写入。`--no-ai-worker` 同样需要此扫描。`--holder --pid <预期 PID> --host <主机>` 使用 worker 相同的函数构造并比较最多 63 字节的应用名，不反向解析可能截断的主机名。

第 8 步尝试 `up` 之前失败或收到 INT/TERM/HUP，部署会带自己的 token 执行 `ops:unfreeze --owned`，只自动解除本次全新创建的冻结。从前次接管的标记即使在 `up` 前也必须保留，只有 `config-write` 通过消费者检查或用户运行 `pnpm ops:unfreeze` 才会删除。从 `up` 开始，失败或中断则保留所有标记。部署在 `config-write` 前不补文件、不写迁移，文件格式仍兼容旧代码，旧 web 的保存也仍写旧格式。再次部署即可继续。没有部署持有部署锁却遗留标记，或 `data/config/`、`data/profile/` 的写锁或 guard 持有者超过过期阈值时，doctor 的 `config.freeze` 会告警。遗留锁在下次写入时自动接管；若保存持续失败，先确认持有者不再写入，再删除锁文件或 guard 内的持有者文件。手工恢复前先确认没有旧消费者，再运行：

```bash
pnpm ops:unfreeze
pnpm config:init
pnpm config:migrate --write
```

`pnpm ops:freeze --target <commit>` 在同一套写锁中创建或接管标记；`pnpm ops:unfreeze` 在锁中删除标记，并提示先运行 `pnpm config:init`，再运行 `pnpm config:migrate --write`。备份排除冻结标记和 `.write.lock`。自动化可用 `pnpm config:migrate --json` 只读查询待迁移和问题数量。

部署后重启部署脚本管不到的宿主长驻进程，例如 `pnpm mcp:serve`。成功写配置后再回退代码，仍需从 `data/config/.backup/` 恢复兼容原件。用 `--skip-pull` 运行不认识标记的旧版部署脚本时，标记可能留下；旧代码忽略它，下次新版部署脚本会接管。较新的配置仍然不能直接给旧代码读。

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

为什么要多这几步：旧容器通过挂载直接读检出目录里的 `config/`。它们还在运行时更新检出目录，就会让旧代码读到新的默认配置（以前每次升级都有这个窗口）；先停掉 web 和 runner 就没有这个窗口了。新的 `deploy.sh` 接着构建带配置的镜像，并去掉挂载重建容器。只运行 `docker compose up -d` 不够：它不会重建已有的镜像，而旧镜像并不带出厂配置（旧 runner 镜像里没有；旧 web 镜像里只有打包时顺带进去的一份不完整的副本），新的 compose 文件（没有挂载）会让它们在出厂配置不完整的情况下启动；它还会跳过配置步骤和迁移。从第一条命令到部署的第 8 步（几分钟，主要是构建），web 和 runner 一直停着；这段时间里到点的采集轮次，runner 启动后会补跑。

之后的升级不需要额外步骤。如果 `pnpm run doctor` 提示（`config.shipped`）有东西挂载在 `/app/config` 上，说明你自己的 compose 文件（比如 `compose.override.yaml`）还在挂载 `./config`：去掉这个挂载，再部署一次。

<a id="first-upgrade-release-dir"></a>

### 升级到 ai-worker 发布目录

从更新日志里带“发布目录”升级说明的那个版本起，主机上的 ai-worker 不再从检出目录运行，而是从部署构建的 `data/releases/ai-worker/<提交>/` 运行（见 [deploy.zh.md](deploy.zh.md)《ai-worker 从发布目录运行》）。从更早的版本第一次升级（可以和上面那次是同一次升级）时，worker 会一直停到部署重新装好它为止，可能发一次“ai-worker 离线”告警；从第 3 步到部署结束，网页和定时轮次也停着。在项目目录里：

1. 卸掉旧 worker：`scripts/ops/uninstall-ai-worker.sh`。旧版本的卸载脚本只认 `io.jobradar.ai-worker` 和 `de.jobradar.ai-worker` 两个 label；如果设过自己的 `doctor.ai_worker_launchd_label`，还要运行 `launchctl bootout gui/$(id -u)/<label>`，并删除 `~/Library/LaunchAgents/<label>.plist`。
2. **核对已经停下**，没停下就不要继续：
   - macOS：`launchctl print gui/$(id -u)/<label>` 报告找不到这个服务，并且 `pgrep -f src/ai-worker/index.ts` 没有输出；
   - Linux：`systemctl --user is-active job-radar-ai-worker` 不是 `active`，并且 `pgrep -f src/ai-worker/index.ts` 没有输出。
3. `docker compose -p job-radar stop web runner`（跳过这一步，旧容器会读到新的 `config/`）。
4. 更新代码：`git pull`，或者用发布标签 `git fetch --tags && git checkout --detach <标签>`。
5. 运行新版本的 `scripts/ops/deploy.sh --skip-pull`。

部署在第 10 步之前停下时，worker 仍然是停的：修好原因，重跑第 5 步。切换以 `rolled back:` 结束时，这里什么都没装（之前就没有）：看原因，修好后重新部署。

### 带查询运行历史的升级

运行用量迁移在同一个事务里为 `runs` 添加 `usage_units`、`window_hours`、`window_extended` 三列和一个索引。
索引不是并发创建的：事务持有 `ACCESS EXCLUSIVE` 锁直到提交，建索引期间 `runs` 的读取和写入都会被阻塞。
如果 `runs` 表很大，请等部署完成后再手动运行采集或打开 `/sources`。

### 带变更指纹的升级

变更指纹迁移新增可空存储列和索引。添加列不会重写岗位或原始招聘表，迁移内也不回填历史行。创建索引仍会持有表锁：
保留正常的迁移前备份，等待部署完成后再手动运行周期。数据库等待迁移期间，岗位详情和 worker 的普通读取仍可使用。

历史行立即保持正确：缺失的指纹在读取时计算。每次维护周期按 `pipeline.yaml: batch_size`，分别为岗位表和原始招聘表
补齐至多一批，每批独立提交；其他写入锁住的行留待后续周期处理。历史数据量大时，需要多个周期才能逐步获得更快的读取。
首次硬过滤还需评估尚无缓存的输入，后续周期会跳过未变化的输入。

只回滚代码时，请保留新增列、索引和触发器；这项变更不需要修改配置或恢复数据库。触发器会为旧版本的源字段写入维护
指纹，并在旧版本改变过滤结论或理由时清除相应缓存。再次升级会安全地重新评估这些结果。

## 回滚

从 `data/config/.backup/` 恢复配置或恢复数据库备份之前，先读 [CHANGELOG.md](../CHANGELOG.md) 里要离开的那个版本的回滚说明。

回滚到补窗之前的版本前，先设 `collect.max_catch_up_hours: 0`，再等待 `lifecycle.possibly_closed_after_days` 天（默认 7），
避免旧代码把最近的变宽运行当作“可能已关闭”的证据。之后，从用户 `data/config/sources.yaml` 中删除
`collect.max_catch_up_hours` 和 `collect.catch_up_tolerance_hours`，再启动不认识这些键的旧代码。

**回滚到交互 AI 通道之前。** 排队中的自动翻译带 `origin: "auto"`，旧 worker 会以 `invalid_payload` 拒绝这些请求；
下一轮 late 翻译阶段会重新处理符合条件的岗位。用户请求仍是原来的载荷格式。升级期间从容器执行切回宿主机、
宿主机 worker 仍是旧代码时，也可能短暂出现同样情况。这项改动没有数据库迁移或新配置键。

要让这些排队中的翻译继续由旧 worker 处理，回滚前先停掉 ai-worker 和 runner，在安装实例的数据库执行以下 SQL，
再启动旧进程：

```sql
update control_requests set payload = payload - 'origin'
where kind = 'translate_job' and status = 'pending' and payload ->> 'origin' = 'auto';
```

**回滚到 AI 查薪资改为仅供参考（`salary.yaml` 的 `config_version: 2`）之前的版本。** 旧代码不会隐藏含 AI 数字的对比。

- **(a) 首选：切换代码前，先用新代码重算。** 基准关闭时，临时把 `salary.yaml` 的 `benchmark.enabled` 改为 `true`，
  运行 `pnpm salary:benchmark`，确认它打印出摘要且退出码为 0，再恢复原值。
- **(b) 配置（必须）：** 无论是把 `salary.yaml` 的 `config_version` 改回旧代码的当前版本，还是从
  `data/config/.backup/<时间戳>/` 恢复原文件，都要在**旧代码启动前**确认 `benchmark.include_ai_lookups` 已删掉或为
  `false`。备份里可能写着 `true`；否则旧代码会把最新缓存结果仍是升级前旧行的查询重新计入。再升级时，对比会被隐藏，
  直到重算。
- **(c) 恢复了数据库备份，或 (a) 没做成：** `pre-deploy` 备份里的基准表还是升级前的，恢复它会覆盖 (a) 的重算结果。
  在旧代码运行、`benchmark.include_ai_lookups` 已删掉或为 `false` 时，再运行一次 `pnpm salary:benchmark`
  （基准关闭时同样临时打开、重算，再恢复原值）。在这次重算之前，旧代码可能显示含 AI 数字的旧对比。

(a) 失败不阻止回滚；按 (c) 处理，并接受这次重算之前的显示窗口。

回到上一个标签：

```bash
scripts/ops/deploy.sh --ref <previous tag>
```

这只会回退代码。`deploy.sh --ref` 会拒绝 ai-worker 发布目录之前的标签（在检出目录移动之前就说明）；要退回那么早，按[降级到发布目录之前的版本](#downgrade-pre-release-dir)手动操作。如果你离开的那个版本应用过数据库迁移，旧代码可能不认识新数据库；此时还要恢复升级时自动做的 `pre-deploy` 备份（这会覆盖数据库）：

```bash
ls -lh data/backups | grep pre-deploy
scripts/ops/restore.sh data/backups/<那个 pre-deploy 备份> --target jobradar --yes
```

恢复会把被替换的库保留为 `jobradar_before_restore_<时间戳>`，所以可以撤销；命令见 [backup-restore.zh.md](backup-restore.zh.md) 第 4 节。runner 在迁移前做的 `premigrate` 备份同样可用。

如果你离开的那个版本迁移过某个配置文件，旧代码会认为它“太新”（`pnpm run doctor` 的 `config.layers` 会提示）：把 `data/config/.backup/<时间戳>/` 里的原件复制回 `data/config/`。
这也涵盖 `config:init` 写进 `schedule.yaml` 的 `deploy.config_write_lock_*` 新键：即使配置版本未变，旧版本也会拒绝这些未知键。启动旧代码前恢复兼容的 `schedule.yaml` 备份。

更多见 [deploy.zh.md](deploy.zh.md)（第 5 节）和 [backup-restore.zh.md](backup-restore.zh.md)。要重新跟随 `main`：`git switch main && scripts/ops/deploy.sh`。

<a id="downgrade-pre-config-freeze"></a>

### 回退到不支持配置冻结的发布

`--ref` 移动检出目录前，正在运行的脚本先检查目标 `scripts/ops/deploy.sh` 的 `# capability: config-freeze` 标记。没有标记的目标沿用旧的第 4 步：`config:init`、`config:migrate --write`、`config:check`；跳过创建冻结和后续 `config-write`，不会调用旧版没有的命令。遗留 `.upgrade-freeze` 标记逐字保留并报告：旧代码忽略它，下次支持协议的升级接管它。用旧脚本 `--skip-pull` 同样不碰标记。启动旧代码前先恢复兼容配置原件；冻结标记不能让旧代码读取新格式。

**只回滚 ai-worker**（应急，比如新 worker 出问题、其他都正常）：之前的发布目录还保留着（`deploy.ai_worker_releases_keep`），所以

```bash
ls data/releases/ai-worker/
scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<上一个提交>
```

一分钟内就能切回去。**这时旧的 worker 代码运行在新版本可能已经迁移过的数据库上**；迁移不向后兼容时，要回滚整个部署。下一次部署之前，`pnpm run doctor` 的 `config.shipped` 会提示“the checkout is at …”，这是预期的。如果那个发布目录已经没了，`scripts/ops/prepare-release.sh <提交>` 会重新构建它。

<a id="downgrade-pre-release-dir"></a>

### 降级到发布目录之前的版本

ai-worker 发布目录之前的版本从检出目录安装 worker，`deploy.sh --ref` 会拒绝它们。在项目目录里手动操作：

1. 用**当前**版本的 `scripts/ops/uninstall-ai-worker.sh` 卸掉 worker（自定义 label 也会卸掉；如果它说定义不明确，按它打印的命令处理），并按[升级到 ai-worker 发布目录](#first-upgrade-release-dir)第 2 步核对已经停下。发布锁 `data/releases/ai-worker/.lock` 存在时（有 deploy 或安装正在运行，或者被杀掉的运行留下了它），它拒绝执行、什么都不改，并打印锁的持有者和清除残留锁的方法。
2. 如果在 `data/config/schedule.yaml` 里加过 `deploy.ai_worker_releases_keep`、`deploy.ai_worker_stop_timeout_seconds`、`deploy.ai_worker_swap_timeout_seconds`、`doctor.shipped_report_skew_seconds`，删掉它们：旧版本不认识这些键，会拒绝这个文件。
3. 可选，并且只能现在做（当前版本的工具还在）：删掉发布目录。发布目录里的目录是只读的，文件可能和 pnpm store 共用，所以只给目录加回写权限，每个路径先核对，不跟随符号链接：

   ```bash
   source scripts/ops/lib/releases.sh
   for d in data/releases/ai-worker/* data/releases/ai-worker/.tmp-* data/releases/ai-worker/.trash-*; do
     [[ -e "$d" ]] && release_rm "$PWD" "$PWD/$d"
   done
   rmdir data/releases/ai-worker data/releases   # 只删空目录
   ```

   如果 `data/releases/ai-worker/.lock` 存在，说明还有部署或安装在运行（或被杀掉了）：先停下来核对（见 [deploy.zh.md](deploy.zh.md)《同一时间只有一次部署》）。已经切到旧版本（没有 `releases.sh`）了？对每个名字是提交号、`.tmp-*` 或 `.trash-*`、并且不是符号链接的目录手动做同样的事：`find -P <目录> -type d -exec chmod u+w {} +`，再 `rm -rf -- <目录>`。不要用 `chmod -R`（会改掉和 pnpm store 共用的文件）。
4. `git fetch --tags && git checkout --detach <旧标签>`。
5. 运行**旧**版本的 `scripts/ops/deploy.sh --skip-pull`：它重建镜像，并像那个版本一样从检出目录安装 worker。
6. 数据库：如果新版本迁移过数据库，按上面的方法恢复 `pre-deploy` 备份。

<a id="unresolved-switch-backup"></a>

### 未解决的切换备份

`scripts/ops/install-ai-worker.sh` 切换之前把已安装的 worker 定义复制到 `data/run/ai-worker-swap-backup/`，切换（或它的回滚）完成后删除这份副本。副本还在，说明某次切换以 `ROLLBACK FAILED:` 结束（或者脚本被杀掉了）：解决之前，之后的每次安装都以 `not changed:` 拒绝，`pnpm run doctor` 也会提示（`ops.ai_worker_swap_backup`）。

1. 看 `ROLLBACK FAILED:` 的消息（或者 `data/run/ai-worker-swap-backup/state`：`found_label` 和 `found_definition` 是之前装的定义）。
2. 停掉所有 ai-worker：macOS 上 `launchctl bootout gui/$(id -u)/<label>`，Linux 上 `systemctl --user stop job-radar-ai-worker`，直到 `pgrep -fl src/ai-worker/index.ts` 没有输出。
3. 要么把保存的定义放回 `found_definition` 指的位置并启动它（`launchctl bootstrap gui/$(id -u) <plist>`，或 `systemctl --user daemon-reload && systemctl --user enable --now job-radar-ai-worker`），要么在下一步重新安装一个发布目录。
4. 删除备份：`rm -rf data/run/ai-worker-swap-backup`。
5. `scripts/ops/deploy.sh --skip-pull`（或 `scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<提交>`），再用 `pnpm run doctor` 核对。

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
