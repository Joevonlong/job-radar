# 备份与恢复

数据库在 Docker 命名卷 `jobradar-pg` 里（在 Docker Desktop 的磁盘镜像中；无论 Docker 数据目录在哪，这个镜像都不是普通文件，不能代替备份）。`data/backups/` 里的 pg_dump 文件是它的常规副本。这个目录在你的项目里；想要异机保护的话，把它纳入你自己的备份流程。

约定：标 **【你来做】** 的步骤要你本人确认或操作；其余命令可以直接复制执行。命令默认在项目目录（包含 `package.json`、`compose.yaml`、`config/`、`data/` 的那个目录）下执行。

## 1. 自动备份

runner 每天按 `schedule.yaml`（用户配置 `data/config/` 里那份）的 `backup` 段执行一次 `pg_dump`（runner 镜像里装的是 `postgresql-client-17`，和 `postgres:17` 同版本）：

```yaml
backup:
  enabled: true
  cron: "30 3 * * *"     # 5 段 cron，按文件开头的 timezone 解释
  keep_daily: 14          # 最近 14 天里，每天最新的一份
  keep_weekly: 8          # 再加最近 8 个 ISO 周里，每周最新的一份
  timeout_minutes: 30     # pg_dump 超时就中止，算失败
  config_archive: true    # 每份 dump 旁边再存一份 data/config 和 data/profile（见本节“配置”）
  pre_migrate: true       # 数据库迁移改动任何东西之前先备份（见本节“迁移前”）
  keep_system: 5          # 每一类安全备份（premigrate、pre-restore、pre-deploy）各保留几份
  keep_old_databases: 1   # 恢复时被替换下来的旧库保留几个（见第 4 节）
```

- 文件：`data/backups/jobradar-YYYYMMDD-HHMMSS.dump`，时间是 `timezone` 的墙上时间。`scripts/ops/backup.sh` 和 `restore.sh` 用同一个时区，这需要系统带时区数据（`tzdata` 包，正常的服务器镜像都有）。没有时，`backup.sh` 会向数据库容器询问时间，而不是悄悄写成 UTC；`restore.sh` 会警告并按文件修改时间给备份排序，`--latest` 因此仍然正确。格式是 pg_dump 自定义格式（已压缩），用 `pg_restore` 恢复，可以只恢复某几张表。
- 先写成 `.partial` 文件（仅所有者可读写，`0600`）。pg_dump 成功退出、每个字节都写入成功、文件已刷到磁盘、并且 `pg_restore --list` 能读完整个目录，才改名，所以备份目录里的 `.dump` 文件都是完整的。写入出错（比如磁盘满）会让这次备份失败并删掉临时文件。保留策略只在备份通过全部检查之后才执行，所以失败的一次不会顶掉旧备份。
- 保留规则（只处理 `jobradar-YYYYMMDD-HHMMSS.dump`，其他文件不动）：每天最新的一份留最近 `keep_daily` 天，每周最新的一份留最近 `keep_weekly` 周，两者取并集，其余删除。天数和周数按"有备份的天/周"数，所以 runner 停机一个月不会把历史删光。
- **配置**：`config_archive: true`（默认）时，每次每日备份之后会再写一个同名的 `jobradar-YYYYMMDD-HHMMSS.config.tgz`：你的用户配置 `data/config/`（不含 `.backup/` 文件夹，也不含登录密钥 `.web-session-secret`，缺了会重新生成）和画像 `data/profile/`。它们不在数据库里，也不在 git 里。压缩包在 dump 之后写入（仅所有者可读写 `0600`，写完读回校验才算数）。写不出来时 dump 照样保留，你会收到警告（一条 `key: config_archive` 的 `alert.backup_failed` 通知；最新的 dump 没有压缩包时 doctor 也会警告）。保留策略会把压缩包和它的 dump 一起删。`.env`（你的密钥）和 `.auth/`（LinkedIn 登录）**不在**任何备份里，请自己留一份。压缩包里有 `sources.yaml`，其中 `jobspy.proxies` 可能带**代理凭据**（`user:password@host`），所以要把 `.config.tgz` 当成机密：不要未经加密就拷到机器之外（用加密的目的地，或先用 `age`/`gpg` 加密）。
- **迁移前**：runner 或 `pnpm db:migrate` 发现有待执行的数据库迁移时，先做一份安全备份 `jobradar-manual-YYYYMMDD-HHMMSS-premigrate-<已应用数>-<随附数>.dump`（带 `.config.tgz`），成功了才迁移。备份失败就不迁移，runner 带着原因停下，所以升级出问题时总能用刚才那份 dump 退回去。已经是最新的库、没有数据的首次安装都不备份。`pre_migrate: false` 关闭（不推荐）。
- **安全备份会被清理，其他手动备份不会**：标签以 `premigrate`、`pre-restore`、`pre-deploy` 开头的备份，每一类按 `keep_system` 保留（默认最新 5 份），每日备份成功后删除更旧的。其他手动备份（`scripts/ops/backup.sh`，不管有没有标签）从不自动删除。注意这是按标签判断的：用 `--label pre-deploy-…`、`--label pre-restore-…` 或 `--label premigrate-…` 命名的手动备份会被当成安全备份，同样会被清理，想长期保留的备份不要用这些前缀。
- 改 `schedule.yaml` 保存后约 5 秒生效（热加载）。`enabled: false` 关闭自动备份。
- runner 启动时如果错过了最近一个备份时间点（比如宿主机 03:30 在关机），并且 `catch_up: true`，会立即补一份。

### 确认它在工作

```bash
ls -lh data/backups
docker compose logs runner | grep -i backup
```

日志里应该有 `next backup: ...` 和每次的 `backup finished`（含文件名、字节数、删除了几份旧备份）。

### 备份失败怎么办

失败时 runner 会：
1. 日志里记 `backup failed`，带原因代码（`pg_dump_failed`、`timeout`、`invalid_output`、`io` ...）；
2. 往 `notifications` 表写一条未发送的 `alert.backup_failed` 记录。启用 Telegram 推送后会把它发给你；否则用下面的命令查看：

```bash
docker compose exec db psql -U jobradar -d jobradar -c "select id, payload_json from notifications where kind = 'alert.backup_failed' and sent_at is null order by id"
```

常见原因：磁盘满（`df -h <你的数据卷>`）、外接卷没挂载（`ls /Volumes`）、`data/backups` 目录没权限（见 [host-setup.zh.md](host-setup.zh.md) 第 1 节）、db 容器没起来（`docker compose ps`）。修好后可以手动补一份：`scripts/ops/backup.sh`。

## 2. 手动备份

做危险操作之前（升级、手动改库、恢复）先备份一份：

```bash
scripts/ops/backup.sh                    # data/backups/jobradar-manual-YYYYMMDD-HHMMSS.dump
scripts/ops/backup.sh --label before-x   # 名字里带标签：...-before-x.dump
```

脚本只需要 Docker（pg_dump 在 db 容器里执行，宿主机上不用装 Postgres）。在重命名 `.partial` 文件前，先用同一容器里的 `pg_restore --list` 检查归档目录，再调用宿主机的 `sync` 刷盘。导出失败、归档不可读或刷盘失败时，删除临时文件并停止备份（等待备份的部署也会停止）。这项检查不能替代完整的恢复演练。手动备份用 `manual` 命名，**不会被自动保留策略清理**，不要了自己删。

配置也一起留：`scripts/ops/backup.sh` 在 `.dump` 旁边写一个同名的 `….config.tgz`，里面是用户配置目录 `data/config/`（不含 `.backup/` 和 `.web-session-secret`）和画像 `data/profile/`。它们不在数据库里，也不在 git 里，这是它们仅有的副本之一。runner 每天的备份写的是同样的压缩包（见第 1 节）。

```bash
tar -tzf data/backups/jobradar-manual-20261009-120000.config.tgz   # 看里面有什么
```

## 3. 恢复演练（建议每月一次）

默认恢复到一个新的临时库，不碰主库，并打印每张表的行数，和线上库并排对比：

```bash
scripts/ops/restore.sh data/backups/jobradar-20261007-033000.dump
scripts/ops/restore.sh --latest                         # 用 data/backups 里最新的备份
scripts/ops/restore.sh --list                           # 列出所有备份，新的在前，带备份年龄
```

`--latest` 按文件名里的日期时间比较，所以不管最新的是自动备份（`jobradar-YYYYMMDD-HHMMSS.dump`）还是手动备份（`jobradar-manual-YYYYMMDD-HHMMSS[-标签].dump`）都能找对。它会打印选中的文件和它的年龄。如果这份备份比 `schedule.yaml` 里的 `backup.max_age_hours`（或 `--max-age-hours N`）还旧，脚本会打印警告并要你确认；没有终端时除非加 `--yes` 否则拒绝（警告仍会打印）。

输出示例：

```
== restoring jobradar-20261007-033000.dump into 'jobradar_restore_20261007033500'
== row counts (restored 'jobradar_restore_20261007033500' vs live 'jobradar')
table                                      restored       live
public.jobs                                    1234       1250
...
restored: 19 tables, 5678 rows
live:     19 tables, 5702 rows (it may have moved on since the backup was taken)
```

- 表的数量应该相同；行数应该略少于线上库（备份之后线上又有新数据）。某张表在 `live` 一栏是 `-`，说明线上库还没有这张表（比如备份来自更新的版本）。`restored` 一栏是 `-` 则相反：这张表比备份更新（备份来自旧版本），备份时它还不存在，runner 启动时迁移会把它建出来。
- 临时库默认保留，方便你检查：`docker compose exec db psql -U jobradar -d <临时库名>`（脚本最后会打印完整命令和删除命令）。看完删除：

```bash
docker compose exec db psql -U jobradar -d postgres -c 'drop database "jobradar_restore_20261007033500"'
```

或者演练时直接加 `--drop`，校验完自动删除：`scripts/ops/restore.sh --latest --drop`。

## 4. 真的要恢复主库  **【你来做】**

只有主库坏了、被误改，或者要回滚到某个时间点时才做。脚本要求你明确写出库名和 `--yes`：

```bash
scripts/ops/restore.sh data/backups/jobradar-20261007-033000.dump --target jobradar --yes
scripts/ops/restore.sh --latest --target jobradar --yes --with-config     # 同一份备份里的配置也一起恢复
```

恢复**从不删除主库**。脚本按顺序做：
1. 先把备份恢复到一个临时库 `jobradar_restore_<时间戳>`，这期间 web、runner 和 ai-worker 照常运行。备份损坏或读不出来就在这一步失败，其他一切都没动。每张表的行数会和线上库并排打印。没加 `--yes` 时脚本到此为止（退出码 1），并告诉你该运行什么；
2. 停掉 `web` 和 `runner`（`docker compose stop web runner`）以及 **ai-worker**（macOS：用 `launchctl`，标签取自 `schedule.yaml` 的 `doctor.ai_worker_launchd_label`；Linux：用户单元 `job-radar-ai-worker.service`；两者都找不到时会有提示，你得自己停掉 worker，因为它也写数据库）；
3. 结束主库上的其他所有连接，把主库改名为 `jobradar_before_restore_<时间戳>`，再把恢复好的副本改名为 `jobradar`（两次改名；第二次失败会把第一次撤销）。旧库就是安全副本，所以不再额外做一次 dump，选错文件也没有损失；
4. 带 `--with-config` 时：先在动任何东西之前检查备份的 `.config.tgz`（只允许 `data/config/` 和 `data/profile/` 下的普通文件和目录；链接、绝对路径和 `..` 都会被拒绝），并解开到暂存目录 `data/.restore-config-<时间戳>`（不采用压缩包里的属主，目录 755、文件 600，和应用自己写的一致）。库切换之后把 `data/config` 和 `data/profile` 改名为 `data/config.before-restore-<时间戳>` / `data/profile.before-restore-<时间戳>`，再把暂存的目录移进去。最后这一步失败时，脚本会打印旧目录和已解开目录的位置，照样启动服务，并以退出码 1 结束。这个选项要求目标是主库；
5. 重新启动 `web`、`runner` 和 ai-worker（`--no-restart` 则保持停止）。runner 会把表结构向前迁移，所以旧版本的备份也能恢复到新代码上；
6. 保留最新的 `backup.keep_old_databases` 个被替换下来的旧库（默认 1 个），更旧的删掉，然后打印回退命令。

脚本被中断（Ctrl-C、`kill`、终端断开）或中途失败时，会在退出前撤销已经开始做的事：切换做到一半就把主库改名改回来，删掉自己建的临时库 `jobradar_restore_<时间戳>`，删除暂存目录，并把它停掉的 `web`、`runner` 和 ai-worker 重新启动。只有确实有东西要撤销时才会打印 `== undoing what this run left half done`。如果终端或机器在脚本来得及撤销之前就没了（断电、`kill -9`），请手动处理：`docker compose start web runner`，并删除残留的 `jobradar_restore_*` 库（`docker compose exec db psql -U jobradar -d postgres -c '\l'` 可以列出它们）。

之后检查：`docker compose ps` 全部 healthy；打开 `http://127.0.0.1:3000` 看岗位列表；runner 日志里应有 `catch-up` 决策（恢复后"最近一轮"变成备份时的状态，可能会立即补跑一轮，这是预期行为）。备份来自旧版本时运行 `pnpm config:migrate --write && pnpm config:check`。

### 撤销一次恢复

恢复前的数据库以 `jobradar_before_restore_<时间戳>` 的名字保留，直到下一次恢复把它替换掉。要退回去，用脚本打印的命令（先停 web 和 runner，也要停 ai-worker）：

```bash
docker compose stop web runner
docker compose exec db psql -U jobradar -d postgres -c 'alter database "jobradar" rename to "jobradar_after_restore_<时间戳>"'
docker compose exec db psql -U jobradar -d postgres -c 'alter database "jobradar_before_restore_<时间戳>" rename to "jobradar"'
docker compose start web runner
```

不再需要的库用 `drop database "<库名>"` 删掉，它们占磁盘。用过 `--with-config` 之后，之前的配置在 `data/config.before-restore-<时间戳>` 和 `data/profile.before-restore-<时间戳>` 里。

不加 `--target jobradar --yes`，脚本绝不会覆盖主库。不加 `--target` 时它恢复到一个新的临时库，主库不动。加了 `--target jobradar` 但没加 `--yes` 时，同样先恢复到临时库 `jobradar_restore_<时间戳>`，打印行数，然后以退出码 1 结束，并提示用同一条命令加 `--yes` 再运行（以及怎样删掉这份检查用的副本）；其他一切都没动。

恢复到别的库（比如要把某张表的数据捞出来对比）：`scripts/ops/restore.sh <文件> --target scratch_db`；目标库已存在时需要 `--yes`。

### 恢复配置  **【你来做】**

不加 `--with-config` 时脚本从不动配置；备份旁边有 `.config.tgz` 时，它会打印恢复命令。手动恢复：

```bash
cp -R data/config data/config.before-restore          # 先留一份现在的
tar -xzf data/backups/<名字>.config.tgz -C .          # 覆盖 data/config 和 data/profile
pnpm config:migrate --write && pnpm config:check      # 备份来自旧版本时先迁移
docker compose restart web runner                     # runner 也会在 5 秒内热加载
```

只想要某一个文件：`tar -xzf <文件>.config.tgz -C /tmp/cfg data/config/ai.yaml`，再自己比对着拷。`config:migrate --write` 每次改文件前也会把原文件放进 `data/config/.backup/<时间>/`，误迁移时从那里拿回。

## 5. 整机重建（换新机器，或 Docker 数据卷丢了）  **【你来做】**

1. 按 [host-setup.zh.md](host-setup.zh.md) 装好 Docker、clone 仓库、`pnpm install`，把备份文件放进 `data/backups/`（项目在外接卷上的话它们本来就在）。
2. 只启动数据库：`docker compose up -d db`，等 `docker compose ps` 里 db 变 `healthy`。
3. 恢复（空库，不重启其他服务，因为它们还没创建）：

```bash
scripts/ops/restore.sh --latest --target jobradar --yes --no-restart
```

4. 把配置和画像放回去。它们不在数据库里；它们在 dump 旁边的 `.config.tgz` 里（每日备份会写一个，`scripts/ops/backup.sh` 也会；见[恢复配置](#恢复配置--你来做)）。选最新的一份，先看内容，再恢复 `data/config` 和 `data/profile`：

```bash
ls -t data/backups/*.config.tgz | head -n 3
tar -tzf data/backups/<名字>.config.tgz
tar -xzf data/backups/<名字>.config.tgz -C .
```

   （新机器上，上一步加 `--with-config` 可以一步做完，但它会把已有的 `data/config` 改名。）没有 `.config.tgz` 就只能从默认值开始，设置和画像要重新填。`.env` 和 `.auth/` 也要自己重建（它们从不进备份）。
5. 启动全部服务：`docker compose up -d --build`。runner 启动时会自动执行迁移（dump 里带了迁移记录，已经是最新的就什么都不做）。

## 6. 注意事项

- **版本**：dump 由 PostgreSQL 17 生成，只能恢复到 17 或更新的服务器。升级 Postgres 大版本前先手动备份，并同步升级 runner 镜像里的 `POSTGRES_CLIENT_VERSION`（`tests/dockerfile.test.ts` 会在两者不一致时报错）。
- **永远不要 `docker compose down -v`**：`-v` 会删除数据库卷。
- **`.env` 和 `.auth/` 不在任何备份里**：`.env` 存着你的密钥和数据库密码，`.auth/` 是 LinkedIn 登录。请自己留一份（值放进密码管理器）。配置和画像在每份 dump 旁边的 `.config.tgz` 里；`config/` 里的出厂默认值随仓库提供。
- **同一块盘**：备份和数据库在同一块盘上，只能防误操作，防不了坏盘。请定期把 `data/backups/` 拷到别处。
- **权限**：备份文件和配置压缩包只有所有者可读写（`0600`），因为它们包含你的整个数据库和设置。
- **磁盘空间**：每份备份的大小见 `ls -lh`；14 + 8 份（再加每类最多 5 份安全备份）约等于 22 份或更多的大小，数据量大了之后看一下 `df -h`。

定时备份与 `scripts/ops/backup.sh` 生成的配置归档均排除 `.upgrade-freeze` 和 `.write.lock`，恢复备份不会带回升级冻结或写锁。
