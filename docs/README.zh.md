# 文档

[English](README.md) | [中文](README.zh.md)

文中的 `ai.yaml` 或 `data/config/ai.yaml` 指你自己在 `data/config/` 里的那份；`config/` 里随产品发布的默认配置是只读的（见 [configuration.zh.md](configuration.zh.md)）。大多数设置也能在设置页或其"高级"标签里改。

第一次用：先 `docker compose up -d --build`，再走 `/setup` 的设置向导（见 [setup.zh.md](setup.zh.md)）。向导之后看[调优指南](getting-started.zh.html)（用浏览器打开）：讲各个页面和怎么调整你收到的内容，带页面示意图。

| 指南 | 内容 |
|---|---|
| [features.zh.md](features.zh.md) | **它做什么**：背后的四个想法、全部功能、各部分怎么配合、截图和短片 |
| [installation.zh.md](installation.zh.md) | **从零安装**：环境要求、macOS、Linux 和 Windows（WSL2）上的每一步、AI worker 装成服务、Telegram、手机访问、升级、备份、卸载、常见问题排查 |
| [faq.zh.md](faq.zh.md) | 简短回答：费用、AI 选项、隐私、来源、市场、手机访问、Windows |
| [setup.zh.md](setup.zh.md) | **首次启动**：设置向导（`/setup`）和 `pnpm run setup`、答案文件、`setup.yaml`、重新打开向导 |
| [usage.zh.md](usage.zh.md) | **日常使用从这里开始**：打开网页、看健康状态（doctor、来源页、告警、日志）、各页面、看 JD、在终端里查岗位 |
| [languages.zh.md](languages.zh.md) | 界面、AI 输出、翻译、Telegram 和命令行的语言（`language.yaml`），怎样加一种界面语言 |
| [configuration.zh.md](configuration.zh.md) | 配置在哪里：默认配置 `config/` 和你自己的 `data/config/`、读哪一份、`pnpm config:init / migrate / check`、`config_version` 升级 |
| [market-packs.zh.md](market-packs.zh.md) | 你找工作的市场：怎么选、哪些跟着它走（地点、远程范围、本地语言、基准货币、渠道）、市场包的文件、怎么写一个包、`pnpm market:show` / `market:regress` |
| [settings.zh.md](settings.zh.md) | 设置页：AI provider / 模型 / 推理强度、手动按钮（立即采集、测试通道、测试 AI、Telegram 测试）、限流 |
| [sources.zh.md](sources.zh.md) | 来源清单：`sources.yaml`、来源 id、七种状态、页面操作、导入导出、`pnpm sources:list` |
| [deploy.zh.md](deploy.zh.md) | 第一次部署清单（偏 macOS）、`scripts/ops/deploy.sh`、`pnpm run doctor`、升级、回滚、7 天无人值守验收表 |
| [upgrade.zh.md](upgrade.zh.md) | 升级到发布标签（`deploy.sh --ref`）、部署做了什么、回滚、卸载 |
| [host-setup.zh.md](host-setup.zh.md) | Docker 自启动、外接卷、电源设置、Tailscale、宿主机上的 CLI 登录、安装 ai-worker、BotFather |
| [multiple-instances.zh.md](multiple-instances.zh.md) | 一人一实例：在第一个实例旁边再跑一个（项目名、卷名、端口）、还要分开什么 |
| [backup-restore.zh.md](backup-restore.zh.md) | `pg_dump` 自动备份、保留策略、恢复演练、灾难恢复 |
| [privacy.zh.md](privacy.zh.md) | 存了什么、什么会离开本机（AI 提供方、招聘网站、Telegram）、提供方的数据政策、怎么彻底删除 |
| [commercial-use.zh.md](commercial-use.zh.md) | 在公司或团队里使用 Job Radar：AGPL、共用实例、抓取和 AI 订阅条款 |
| [ai-providers.zh.md](ai-providers.zh.md) | 订阅命令行、API key 或两者都用的 AI：谁在哪里跑什么、宿主机 ai-worker、`execution` / `host_worker` / `translation` 配置、排错 |
| [ai-usage.zh.md](ai-usage.zh.md) | AI 用量和费用统计、模型目录（`models.yaml`） |
| [deal-breakers.zh.md](deal-breakers.zh.md) | 自己写的一票否决规则（`preferences.yaml: deal_breakers`）：语言门槛、短语、签证规则、被否决的岗位会怎样、`pnpm deal-breakers:check`、回滚前要做的事 |
| [extraction.zh.md](extraction.zh.md) | 办公方式、德语等级、中介识别、描述整理的规则；`pnpm reprocess` |
| [signals.zh.md](signals.zh.md) | 薪酬与福利信号：档位、词表、两步提取、看板 |
| [salary.zh.md](salary.zh.md) | 岗位页的薪资水平（按你采集的岗位做的基准、薪资网站链接）和可选的 AI 查薪资（网页搜索），`salary.yaml` |
| [breakdown.zh.md](breakdown.zh.md) | 岗位拆解：手动 / 自动、卡片状态和错误码、引用核对、`breakdown.yaml` |
| [ai-traps.zh.md](ai-traps.zh.md) | AI 陷阱检测：能认出哪些手段、哪些来源只有文字、发给 AI 的文字怎么清洗、页面和推送上的标记、`traps.yaml`、`pnpm traps:scan` |
| [score-evidence.zh.md](score-evidence.zh.md) | 详情页的理由来源：原文引用、推断、未提及，引用怎么核对，成本，旧分数，`ai.yaml: scoring.evidence`，回滚前要做的事 |
| [ghost-jobs.zh.md](ghost-jobs.zh.md) | 招聘帖背后可能没有真实空缺的迹象：五个信号和分值、列表标记和筛选、详情页一行、"不是幽灵岗位"、`pnpm ghost:check`、设置 |
| [visa-sponsorship.zh.md](visa-sponsorship.zh.md) | JD 里关于签证赞助或工作许可的说法：四种结果、列表徽标和筛选（给需要赞助的用户）、详情页一行、签证一票否决、`pnpm visa:scan`、设置 |
| [insights.zh.md](insights.zh.md) | 统计页 /insights：每张卡片怎么算、`insights.yaml` |
| [interest-suggestions.zh.md](interest-suggestions.zh.md) | 每周 AI 建议：证据规则、批准 / 拒绝、`suggest` 配置 |
| [resume-kit.zh.md](resume-kit.zh.md) | 定制简历联动：`resume.yaml`、导出 JD、`/tailor` 命令 |
| [application-writer.zh.md](application-writer.zh.md) | `/me` 上的经历素材库（`stories.yaml`）：一条素材有什么、id、历史和回滚、`writer.yaml` 里的上限、什么会发到哪里；工作台 `/jobs/<id>/apply`（申请回答和动机信，逐句核对依据） |
| [mcp.zh.md](mcp.zh.md) | 在 Claude Desktop、Claude Code 等 MCP 客户端里问你的岗位和申请：可选的只读 MCP 服务（`pnpm mcp:serve`、`mcp.yaml`）、工具、给什么和永远不给什么 |
| [telegram.zh.md](telegram.zh.md) | 建 bot、拿 chat id |
| [gmail-alerts.zh.md](gmail-alerts.zh.md) | 两步验证、应用专用密码、标签、订阅职位提醒 |
| [linkedin-session.zh.md](linkedin-session.zh.md) | `pnpm auth:linkedin`、每日页面上限、遇到验证页怎么办 |
| [jsearch.zh.md](jsearch.zh.md)、[tavily.zh.md](tavily.zh.md)、[apify.zh.md](apify.zh.md)、[brightdata.zh.md](brightdata.zh.md)、[monid.zh.md](monid.zh.md) | 需要 key 或付费的通道：key、额度和预算 |
| [development.md](development.md) | 给贡献者：代码结构、测试、e2e、约定（英文） |
| [roadmap.zh.md](roadmap.zh.md) | 后续版本计划做的事 |
| [ci.zh.md](ci.zh.md) | CI 流水线逐任务逐步骤说明：每步做什么、为什么、耗时、本地复现、怎么读失败、e2e 的 project、Dependabot、发布检查 |
