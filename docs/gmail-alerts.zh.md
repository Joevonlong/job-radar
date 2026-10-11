# Gmail 岗位提醒邮件

通道 `gmail-alerts` 读取 LinkedIn、StepStone、Indeed、XING 发到你 Gmail 的岗位提醒邮件，把每封邮件里的岗位卡片变成岗位数据。这些平台已经按你订阅的关键词和城市筛过一轮，而且这条路径**不碰任何平台的反爬**，只需要对一个标签的只读访问，从不发送或删除邮件。

## 它做什么、不做什么
- IMAP（imapflow）+ 应用专用密码，**只读**一个标签（默认 `JobAlerts`）：用 `EXAMINE` 只读方式打开，邮件正文用 `BODY.PEEK` 读取。**不标已读、不移动、不删除、不加标签**；代码里没有任何写邮箱的调用。
- 按发件人域名选解析器（`sources.yaml` 的 `sources.gmail.senders`）。一封邮件里的每个岗位卡片 → 一条原始岗位（职位、公司、地点、链接；有就带薪资和摘要）。
- 已处理的 Message-ID 记在数据库表 `email_messages`，同一封邮件只读一次。
- 解析失败（版式变了、没有 HTML 部分、认不出岗位卡片）：整封邮件原文入库（`raw_postings`，种类 `email_unparsed`）并标 `parse_failed`，失败原因写在 `parse_error`；其他邮件照常处理。卡片缺公司名的岗位单独标 `parse_failed`（不猜公司）。
- 标签里混进了不属于这四家的邮件：不读正文、不入库，只在 `email_messages` 里记一行（`parse_failed`），避免每轮重复检查。
- 同一个岗位在其他通道（公司 ATS、LinkedIn 等）也出现时，由跨源归并合并成一个岗位；邮件里的链接作为一个来源（优先级见 `pipeline.yaml: apply_priority.email`，默认 4，最低）。
- 不做 OAuth。

## 1. 开两步验证，生成应用专用密码
1. Google 账号 → 安全性 → 开启「两步验证」。
2. 打开 <https://myaccount.google.com/apppasswords>（只有开了两步验证才有这个入口），随便起个名字（例如 `job-radar`），生成 16 位应用专用密码。Google 显示时带空格，带不带空格都行。
3. Gmail 设置 → 转发和 POP/IMAP → 确认「IMAP 访问」是开启状态（新账号默认开启）。
4. 写进 `.env`（已 gitignore，不要提交、不要贴到聊天或日志里）：
   ```
   GMAIL_USER=你的完整邮箱地址
   GMAIL_APP_PASSWORD=应用专用密码
   ```
   不用了就到同一页面撤销这个密码。

## 2. 建 `JobAlerts` 标签和过滤器
1. Gmail 左侧「创建新标签」→ 名字 `JobAlerts`（要改名就同步改 `sources.gmail.label`；Gmail 的标签就是 IMAP 里的文件夹名，嵌套标签用 `Parent/Child`）。
2. 搜索框右侧「显示搜索选项」→ 「发件人」填下面这串，点「创建过滤器」：
   ```
   jobalerts-noreply@linkedin.com OR jobs-listings@linkedin.com OR alert@indeed.com OR noreply@jobalert.indeed.com OR jobs@stepstone.de OR noreply@stepstone.de OR no-reply@mail.xing.com OR jobs@xing.com
   ```
   发件地址以你实际收到的提醒邮件为准（打开一封看「发件人」）；`sources.yaml` 里是按域名匹配的（`linkedin.com`、`stepstone.de`/`.com`/`.at`、`indeed.com`、`xing.com`，含子域名），所以地址变了只要域名没变就不用改配置。
3. 勾选「应用标签：JobAlerts」。可以同时勾选「跳过收件箱」（岗位只在看板里看）；通道不依赖已读 / 未读状态，也不会改它。
4. 勾选「同时将过滤器应用于 N 个匹配的会话」，把历史的提醒邮件也归进标签。

## 3. 在四家平台订阅提醒
关键词和城市与 `data/config/search.yaml` 保持一致（关键词组 × `locations` + 远程）。频率选"每天"即可；实时提醒邮件太多，`max_messages_per_cycle` 默认每轮只读 50 封。

| 平台 | 在哪里订阅 |
|---|---|
| LinkedIn | 搜索职位 → 左侧或右上「设置提醒」/ Set alert → 频率 Daily，渠道选电子邮件 |
| StepStone | 搜索结果页 →「Job-Alert erstellen」→ 频率每天 |
| Indeed | 搜索结果页 → 「Receive new jobs for this search by email」/「Neue Jobs per E-Mail erhalten」 |
| XING | 职位搜索 →「Suchauftrag speichern」→ 开启邮件通知 |

## 4. 配置（`data/config/sources.yaml` → `sources.gmail`）
| 键 | 含义 |
|---|---|
| `enabled` | 开关；配好 `.env` 和标签后改成 `true`（runner 热加载配置，但第一次写 `.env` 后需要重启 runner 一次） |
| `host` / `port` / `secure` | IMAP 服务器，默认 `imap.gmail.com:993` 隐式 TLS；`secure: false` 只用于连本地测试服务器 |
| `label` | 只读这一个标签 |
| `max_messages_per_cycle` | 每轮最多读多少封（新的优先）；读不完的留到下一轮 |
| `lookback_days` | 只看最近这么多天收到的邮件（默认 14） |
| `max_results` | 每轮最多产出多少条岗位。一封邮件不会被切成两半：超出上限后不再开始读新的邮件 |
| `timeout_ms` | 连接 / 问候 / 套接字超时 |
| `senders` | 平台 → 发件人域名列表 |

## 5. 线上冒烟
```bash
# 1) data/config/sources.yaml: sources.gmail.enabled: true；.env 里写好 GMAIL_USER / GMAIL_APP_PASSWORD
pnpm cycle:run --channel gmail-alerts --dry-run      # 只读邮箱、在内存里解析，不写库
pnpm cycle:run --channel gmail-alerts                # 真正入库（email_messages / raw_postings / jobs）
```
dry-run 会列出解析出的岗位数和前几个标题；`parsed N/M (K failed to parse)` 里 K 不为 0 说明有邮件版式认不出，到 `raw_postings` 里查 `parse_status = 'parse_failed'` 的原文（`payload_json->>'reason'`）。

## 6. 排错
| 现象 | 原因 / 处理 |
|---|---|
| 来源卡片显示“未配置”（没有运行记录，不发请求） | `.env` 里没写 `GMAIL_USER` 或 `GMAIL_APP_PASSWORD`，或 runner 没重启 |
| `auth_expired`：Gmail rejected the login | 应用专用密码错了或已撤销；确认两步验证仍开着；`GMAIL_USER` 要是完整地址 |
| `the configured Gmail label does not exist` | 标签名和 `sources.gmail.label` 不一致（区分大小写；嵌套标签写 `Parent/Child`） |
| `network` | 连不上 `imap.gmail.com:993`（防火墙 / 网络）；通道的熔断器会按 `circuit_breaker` 处理 |
| 某平台一直没有岗位 | 看日志里 `no <platform> job cards recognised`：说明该平台改了邮件版式，原文已入库（`parse_failed`），把那封邮件的 HTML 脱敏后加进 `tests/fixtures/email/` 再调解析器 |
| 日志 / 错误信息 | 不含账号和密码；只含 IMAP 错误代码 |

## 7. 解析器和样本（开发者）
- 解析器在 `src/lib/channels/email/parsers/`（每家一个文件），共用 `html.ts` 的卡片发现：找出指向岗位的链接（平台岗位 id 在链接里）→ 按岗位分组 → 取包含这一组链接且不含别的岗位 / 页脚链接的最大祖先 → 标题之后的文本行依次是公司、地点，其余去掉状态徽章后是摘要。不依赖 CSS class（邮件里的 class 经常混淆、常变）。
- 链接规范化：解开 `url=` 之类的跳转包装；LinkedIn → `linkedin.com/jobs/view/<id>/`，Indeed → `viewjob?jk=<id>`，StepStone / XING 去掉追踪参数；认不出 id 的（例如 Indeed 的赞助链接）用规范化后的链接做 external id。
- 薪资只取邮件里写明的；平台的"Gehaltsprognose / 估算"不当薪资。
- `tests/fixtures/email/*.html` 是按各平台提醒邮件公开的链接格式和卡片结构**自己构造的样本**（虚构公司、不含任何真实邮件或个人信息），见该目录的 README。真实邮件的版式和样本不一致时，以真实邮件为准更新样本和解析器。
