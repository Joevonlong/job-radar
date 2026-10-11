# LinkedIn 登录态通道（Playwright）

通道 `linkedin-session` 用**你自己的 LinkedIn 登录态**（一个 Playwright 浏览器）读 LinkedIn 的职位搜索页和岗位详情页，是 LinkedIn 级联的第 3 位（Bright Data → Apify → session → guest）。另有旁路 `linkedin-session:recommended`：每天读一次"为你推荐"，不参与级联。

它**只读**：打开页面、读页面，不点赞、不申请、不发消息、不关注、不填任何表单。遇到登录页、验证页（checkpoint / CAPTCHA / 安全验证），立即停止、熔断、发 Telegram，**绝不尝试自动通过**——验证由你自己在普通浏览器里完成。

> 状态：代码和测试完成，但还没有用真实登录态做冒烟——需要你先运行 `pnpm auth:linkedin` 登录一次（见"真实冒烟"）。页面选择器按 LinkedIn 登录后页面的公开结构写成，用保存的 HTML fixture 测过，还没有对着真实登录态验证过。

## 风险提醒
- 用登录态自动读 LinkedIn 违反它的用户协议；它可能限制或封停你的账号。所以默认关闭、请求量很小（见下）、只读、遇到验证立即停。要不要开由你决定；级联里其他通道（Bright Data / Apify / guest）不依赖它。
- 登录文件 `.auth/linkedin.json` 里是会话 cookie，等同于登录状态：不提交（已 gitignore）、权限 600、不发给任何人、不放进镜像。泄露了就在 LinkedIn 的"设置 → 登录和安全 → 在哪里登录"里退出所有设备。

## 第一次设置
1. 在**宿主机**（不是容器）的项目目录打开终端：
   ```bash
   pnpm exec playwright install chromium   # 只需第一次
   pnpm auth:linkedin
   ```
2. 弹出一个有界面的 Chromium 窗口，停在 LinkedIn 登录页。**你自己**输入账号密码、完成两步验证。看到自己的信息流后**关闭这个窗口**。
3. 脚本在你关闭窗口时把登录态（cookie）存到 `.auth/linkedin.json`（目录 700、文件 600）。它**不读、不存、不输入密码**；窗口里输入的任何内容它都看不到，只在登录成功后保存浏览器的 cookie。
4. 如果数据库可达（`DATABASE_URL`），脚本还会把登录态标为"有效"，并关掉因登录失效 / 验证而打开的熔断，不用等冷却。
5. 先试一轮，再打开通道：
   ```bash
   # data/config/sources.yaml 里先把 linkedin.session.enabled 改成 true，然后：
   pnpm cycle:run --channel linkedin-session --dry-run
   ```
   干跑会真的打开 LinkedIn 页面（有请求），但不写数据库、不计入当天用量。输出里看 `fetched / parsed`。
6. 没问题就留着 `enabled: true`。runner 在 Docker 里时，`./.auth` 以只读方式挂进容器（`compose.yaml` 已写好），需要 `docker compose up -d --build` 一次让镜像带上 playwright-core。

`pnpm auth:linkedin --status` 只看状态，不打开浏览器：文件在不在、cookie 到期时间、通道最近知道的状态。

## 配置（`data/config/sources.yaml` → `linkedin.session`）
| 键 | 含义 |
|---|---|
| `enabled` | 开关（默认关）。没有登录文件时通道显示"未登录"，级联直接跳过它，不算失败 |
| `monthly_budget_usd` | 保持 0（没有付费用量） |
| `throttle` | 两次页面加载之间随机等 3~8 秒 |
| `max_results` | 每个查询最多读多少条（再受 `search.yaml: max_per_group_per_location` 限制） |
| `daily_request_limit` | 每个自然日（`schedule.yaml` 时区）最多加载多少个 LinkedIn 页面（搜索页、详情页、推荐页合计，两个 session 通道共用）。默认 200。用完后通道被跳过，级联换下一个 |
| `max_pages` | 每个查询最多翻几页搜索结果（每页约 25 条） |
| `fetch_details` | 是否为每条**新**岗位打开详情页（JD、薪资、办公方式、申请人数）。库里已有的岗位不再打开：原样重新交付（保持"最近看到"时间），不产生请求 |
| `recommended_daily` / `recommended_max_results` | 是否读"为你推荐"、最多读几条 |
| `site.base_url` / `site.auth_file` / `site.country_name` / `site.remote_locations` | 站点、登录文件路径（相对项目目录）、城市查询的国家、远程查询的地点 |
| `browser.*` | `headless`、页面超时、渲染等待、滚动次数和停顿（列表只渲染可见卡片）、语言、不加载的资源类型、User-Agent |

`data/config/schedule.yaml` 的 `linkedin_recommended`（`enabled`、`cron`，默认每天 07:00）决定"为你推荐"何时读。它不是单独的定时任务：处理轮里，第一轮发现"今天的 cron 时间点已过、还没读过"时顺带读一次；手动运行总会读。

## 它怎么工作
- **搜索**：每个查询 = `search.yaml` 的一个关键词组 × 一个城市（或远程）。URL：`/jobs/search/?keywords="A" OR "B"&location=<城市, 国家>&f_TPR=r<回看秒数>&sortBy=DD`，远程加 `f_WT=2`。打开后滚动列表让卡片全部渲染，读出每张卡的岗位 id、标题、公司、地点、发布时间；然后对库里没有的岗位打开 `/jobs/view/<id>/`，读 JSON-LD `JobPosting` 和页面上的薪资、办公方式、雇佣类型、申请人数、JD。
- **id 与去重**：岗位 id 就是 LinkedIn 的数字 id，和 Bright Data / Apify / guest 通道一致，同一个岗位被不同通道取到会合并成一个。
- **原始数据**：存的是页面上读到的字段，JD 以 HTML 保存，方便以后 `pnpm reprocess` 重新解析。不存 cookie、请求头、整页 HTML。
- **登录态状态**（`/sources`）：**未登录**（没有登录文件或没有会话 cookie）、**有效**、**已过期**（cookie 到期，或通道被带到登录页 / 验证页后你还没重新登录）。重新运行 `pnpm auth:linkedin` 后自动恢复。"上次成功"时间显示在通道卡片上。
- **缺登录文件时**：`isConfigured` 为假，级联跳过 session，下一个通道（guest）接上；"为你推荐"不运行。
- **只一个浏览会话**：两个 session 通道共用一个账号、一个计数器，进程内一次只开一个浏览器。

## 遇到验证 / 登录页时
通道在**第一个**这样的页面上立即停止（不再加载任何页面），然后：
1. 把登录态标为"已过期"（`runtime_state`，`/sources` 可见），
2. 抛出可熔断的错误：登录页 / 授权墙 → `auth_expired`，验证页 / checkpoint / CAPTCHA / HTTP 999 / 403 → `blocked`，一次就开熔断（`circuit_breaker.cooldown_hours`），
3. Telegram 告警：登录失效 → "LinkedIn 登录态失效，需要重新登录"；验证页 → "LinkedIn 通道 … 遇到验证页或被拦截"（提示自己去普通浏览器里完成验证）。同一告警 `alerts.dedupe_hours` 内只发一次，
4. 同一个查询和本轮后面的查询交给级联里的下一个通道（guest）。

恢复：自己在普通浏览器里登录 LinkedIn、完成它要求的验证，然后运行 `pnpm auth:linkedin`。HTTP 429 只算一次可重试失败（不立即熔断，连续失败才熔断）。页面结构变了（既没有岗位卡片、也不是"没有结果"页）会报 `parse` 错误，不会悄悄返回空。

## 容器与权限
- runner 容器里 Playwright 基础镜像带浏览器，`playwright-core` 在镜像里单独安装（`build:runner` 把它标为 external）。`/dev/shm` 很小，已加 `--disable-dev-shm-usage`。
- `.auth/` 以只读方式挂进 runner 和 web（web 只用它判断"未登录 / 有效"，不浏览）。macOS 的 Docker Desktop 上权限 700/600 没问题；Linux 宿主机上容器用户看不到 600 的文件时，把 `.auth/` 的属主改成容器用户的 uid，不要放宽权限。
- 宿主机直接跑也行：`pnpm cycle:run --channel linkedin-session`。

## 真实冒烟
执行 `pnpm auth:linkedin` 之后：
1. `pnpm auth:linkedin --status` 应显示"有效"。
2. `pnpm cycle:run --channel linkedin-session --dry-run`：看 `fetched`、`parsed`、`parseFailed`、示例标题；页面选择器如果对不上，会表现为 `parse` 错误或 `cardOnly`（详情页读不出来、只保留了列表卡片）。
3. `pnpm cycle:run --channel linkedin-session:recommended --dry-run`。
4. 对着真实页面对一遍：把页面 HTML 脱敏后替换 `tests/fixtures/linkedin-session/` 里的 fixture，再跑 `pnpm test` 看解析器是否仍然通过。
