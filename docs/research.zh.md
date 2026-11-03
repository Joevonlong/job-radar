# 公司背景

[English](research.md) | [中文](research.zh.md)

岗位页可以显示这家公司公开可查的信息：做什么、行业和规模、成立时间、总部、融资、产品、工作语言、员工评价网站怎么说、近期动态。这些内容在你按下按钮时，由 AI provider 通过网页搜索得到。**默认关闭。**

面板里的一切都是 AI 网页搜索的结果，面板上也这样标明（“AI 网页搜索 · 未核对”）。Job Radar 没有核对来源是否正确。要依赖某个字段，先看它的来源。评分、过滤、推送和其他 AI 任务都不用这些结果，它们只用来显示。

## 打开

设置 → 调研 →“启用公司背景”，或者在 `data/config/research.yaml` 里写 `enabled: true`。之后岗位页的“公司背景”面板会显示“查公司背景”按钮。不按就不会查。

用哪个 AI，由 AI 页的任务“公司背景”决定。默认顺序是 `claude-cli`，然后是 Anthropic API。只使用能搜索网页的 provider。一个可用的都没有时，面板会说明，不显示按钮。

## 什么会离开本机

| 发送的内容 | 何时 |
|---|---|
| 公司名，已去掉标记和控制字符 | 每次查询 |
| 公司官网域名，**仅限你自己确认过的** | 这家公司的每次查询 |

绝不发送：岗位标题、地点、JD、你的画像，以及 Job Radar 从岗位推断出的域名。任何人都能在岗位里写任意链接，所以这种域名既不进入请求，也不进入 AI 可打开的网页列表。

这些内容发给该任务的 provider，由它去搜索网页。被读取的网站看到的是来自 provider 的请求，不是来自你的。

## 限制能管到哪里

- **`claude-cli`**：只对 `company.allowed_domains` 里的站点和你确认的域名预先放行打开网页，其他工具调用一律拒绝。这是 CLI 自己的权限检查，不是网络边界。它的网页搜索**不受**这些站点限制。
- **Anthropic API**：搜索结果和打开的网页由 API 限制在这些站点内，`max_searches` 也由 API 执行。
- **`codex-cli`**：不在默认顺序里，因为它的网页搜索完全不限域名。如果你自己把它加进这个任务，面板和设置的 AI 标签页都会提示。
- 站点列表里如果有私有地址、本地名称或公共后缀，加载文件时会被拒绝。

## 存储前的检查

回答不可信：AI 读过网页。每个字段独立判断。出现下面任何一种情况，这个字段就被丢弃，并计入面板上的丢弃数：

- 来源不是公开的 `https` 链接（不能是 IP 地址、本地或保留名称，不能带账号密码或其他端口）；
- 文字或来源链接里有不可见字符；
- 文字或来源链接里有写给 AI 的内容（用 `traps.yaml` 的指令模式判断，不管岗位陷阱扫描是否打开）；
- 数值不可能成立：员工数或评分超出 `company.employees` / `company.rating`，成立年份或新闻日期在未来，或日期格式不对。

剩下的内容是纯文本，长度受 `company.max_field_chars` 限制，显示时也是纯文本，来源是链接。一个字段都不剩时，不保存任何内容，面板说明没有可用结果。`traps.yaml` 读不出来时，查询直接失败，不保存未经检查的回答。

## 结果

结果属于公司，所以这家公司的所有岗位都显示它。它在 `company.ttl_days` 天内算有效。过期后面板仍然显示，并提示可能过时。“重新查询”总是重新搜索。确认了另一个官网后，已存结果就不再算有效，面板会提示。两家公司合并时，结果移到保留的公司。

关闭功能后，结果仍留在数据库（表 `company_research`），面板继续显示，只是没有按钮。删除数据库才会删除它。

## 上限和费用

- `company.max_per_day`：过去 24 小时的请求数。每次请求都算，失败的也算；直接用已存结果的不算。
- `company.max_searches`：一次查询的搜索次数。Anthropic API 严格执行，CLI 只是被要求遵守。
- `company.timeout_seconds`：整个查询的时间，包括所有 provider 和重试。
- 查询会消耗 token；用 Anthropic API 时每次搜索还有费用（用量页按 `company.web_search_usd` 计算）。见 [ai-usage.zh.md](ai-usage.zh.md)。

## `research.yaml`

表单包含开关、`ttl_days`、`max_per_day`、`max_searches` 和 `timeout_seconds`。下面这些在文件里改（设置 → 高级）：

| 键 | 作用 |
|---|---|
| `company.allowed_domains` | 除你确认的域名外，可以打开网页的站点。不能是私有或本地名称，也不能是公共后缀。 |
| `company.non_company_hosts` | 绝不当作公司官网的主机（招聘网站、社交网络）。 |
| `company.max_field_chars` | 一个字段最多存多少字符。 |
| `company.employees`、`company.rating` | 这些数值的合理范围。 |
| `company.web_search_usd` | 用量统计里一次搜索的费用。 |

## 回滚前

迁移只新增一张表和 `companies` 的三列，旧代码会忽略它们。旧代码也会忽略 `research.yaml`。如果表单保存时把 `tasks.company_research` 写进了 `ai.yaml`，旧代码会拒绝这个文件：切换前删掉这个键（以及 `reasoning_effort_by_task.company_research`，如果有）。

## 出问题时

| 面板显示 | 怎么办 |
|---|---|
| 没有能搜索网页的 provider | 在 AI 页给这个任务选 `claude-cli` 或 Anthropic API |
| 登录或密钥被拒绝 | 修复 CLI 登录，或 `.env` 里的密钥 |
| 达到每日上限 | 等一等，或调高 `company.max_per_day` |
| 没有内容通过检查 | 没有保存任何内容。稍后再试；名字对应多家公司时常常查不出结果 |
| `research.yaml` 读不出来 | 运行 `pnpm config:check` 查看原因 |
