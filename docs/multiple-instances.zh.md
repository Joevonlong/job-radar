# 多个实例

[English](multiple-instances.md) | [中文](multiple-instances.zh.md)

Job Radar 为一个人设计：一份个人画像、一套求职偏好、一个 Telegram 对话。应用里没有多用户模式。两个人（或者你自己再试一个新版本）就运行**两个实例**：两份检出，各有自己的数据库、配置、画像和端口。

## 必须不同的地方

第二份检出如果沿用默认名字，会接管第一个实例的容器并共用它的数据库。第一次 `docker compose up` 之前，在它的 `.env` 里起自己的名字：

```bash
git clone https://github.com/Joevonlong/job-radar.git ~/job-radar-anna
cd ~/job-radar-anna
cat >> .env <<'ENV'
COMPOSE_PROJECT_NAME=job-radar-anna   # 容器和网络（覆盖 compose.yaml 里的 name:）
JOBRADAR_PG_VOLUME=jobradar-anna-pg   # 数据库卷（默认的 jobradar-pg 属于第一个实例）
JOB_RADAR_WEB_PORT=3001               # 面板：http://127.0.0.1:3001
DB_HOST_PORT=5434                     # 数据库在宿主机上的端口（宿主机命令、ai-worker）
ENV
docker compose config | grep -E '^name:|jobradar-|published'   # 启动前先核对名字
docker compose up -d --build
```

| 变量 | 第一个实例（默认） | 为什么必须不同 |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `job-radar` | compose 按项目名找“自己的”容器：同名就是同一批容器。 |
| `JOBRADAR_PG_VOLUME` | `jobradar-pg` | 卷名在整个 Docker 主机上是全局的（不带项目名前缀）：同名就是同一个数据库。 |
| `JOB_RADAR_WEB_PORT` | `3000` | 宿主机的一个端口只能有一个程序监听。 |
| `DB_HOST_PORT` | `5433` | 同上。 |

**已有实例永远不要改这些名字**：换了 `JOBRADAR_PG_VOLUME`，compose 会启动一个空数据库，旧库只有改回旧名字才能再访问。doctor 会从 `.env` 读取 `COMPOSE_PROJECT_NAME`、`JOB_RADAR_WEB_PORT` 和 `JOB_RADAR_WEB_BIND`；它的 `compose.project` 检查会在该项目名的容器是从另一份检出启动时给出警告。

## 其他要分开的东西

- **Telegram**：每个实例要有自己的 bot（`TELEGRAM_BOT_TOKEN`）；两个程序轮询同一个 bot 会互相抢消息。
- **AI worker**：一个数据库一个 ai-worker。`scripts/ops/install-ai-worker.sh` 在每个系统用户下只装一个服务（macOS 上是 `io.jobradar.ai-worker`，Linux 上是 `job-radar-ai-worker.service`），对应运行它的那份检出；同一台机器上的第二个实例，请在它的检出里用你自己的进程管理器运行 `pnpm ai-worker`，或换一个系统用户。
- **手机访问**：`tailscale serve` 把一个 HTTPS 端口映射到一个本地端口；第二个实例用另一个 HTTPS 端口（`tailscale serve --bg --https 8443 3001`），并把它的 `notify.yaml: public_base_url` 设成那个地址。
- **个人画像**：在实例之间复制设置时，只复制 `data/config/` 里的文件，不要复制 `data/profile/`（`me.yaml` 是这个人，`preferences.yaml` 是他要找什么）；新的人在设置向导里建立自己的画像。
- **网页口令**：每个实例各有自己的口令（在各自的检出里 `pnpm web:password`）；一个实例的会话打不开另一个。
- **发布到回环以外**：`JOB_RADAR_WEB_BIND` 必须写这个实例实际发布的地址。如果改它的 `ports:` 或用 compose override 把第二个实例开放到局域网，而这个变量还是 `127.0.0.1`，那个实例仍然让自称本机的请求跳过登录；它的 doctor 会让 `compose.web` 失败（“本机免登录仍然开着”）。见 [configuration.zh.md](configuration.zh.md#网页访问可选口令监听地址和端口)。

## 删除一个实例

在它的检出里：`docker compose down`（容器和网络），然后，只有在确定时，`docker volume rm <它的 JOBRADAR_PG_VOLUME>`。`docker compose down -v` 删除的是**这份**检出 `.env` 里指定的卷：只在你要删除其数据库的那份检出里运行。见 [upgrade.zh.md](upgrade.zh.md#卸载)。
