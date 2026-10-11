# resume-kit 联动

resume-kit 是一个独立工具，**不在本仓库里**。在 `resume.yaml` 里设置 `resume_kit_path` 之前，"定制简历"按钮（岗位详情页头部的和 Telegram 里的）都是隐藏的；详情页下面的导出面板仍在，可以给你 JD 文件。**隐私：**你粘贴到终端里的 `/tailor` 命令会让 Claude 读取你的**完整简历**和岗位描述，这两样都会发给 Anthropic，见 [privacy.zh.md](privacy.zh.md)。

岗位详情页的"定制简历"把 JD 交给 resume-kit 的 `/tailor` 技能，生成的 PDF 再挂回申请记录。Claude Code 不在容器里运行，由你在终端里粘贴命令。

## 配置：`data/config/resume.yaml`

这些路径、`claude_command` 和 `claude_args` 是受保护的键：设置页里只读，请手动编辑文件来设（见 [configuration.zh.md](configuration.zh.md#受保护的键只能手动改)）。

| 键 | 含义 |
|---|---|
| `resume_kit_path` | resume-kit 的本地目录（绝对路径）；null 时只给 JD 路径，不给命令 |
| `master_resume_path` | 你的主简历 YAML（在本仓库之外）；只写进命令，系统不会读它 |
| `pdf_dir` | 定制 PDF 所在目录；"挂上简历"只接受这里的文件；null 时不能挂 |
| `jd_export_dir` | JD 导出目录，默认 `data/exports/jd`（相对项目目录） |
| `jd_export_host_dir` | 在 Docker 里运行时，宿主机看到的导出目录（命令里用它）；默认 null |
| `claude_command` | 终端里启动 Claude Code 的命令，默认 `claude` |
| `claude_args` | 放在命令里 `claude_command` 之后的额外参数，默认 `--disallowed-tools=WebFetch,WebSearch`（只接受字母、数字、`_ = , . : / -` 和空格） |

文件改完在下一次打开详情页时生效（网页进程每次重新读取）；runner（Telegram 按钮）由配置热加载接管。

## 不可信的岗位文本

JD 文件里是发布岗位的人写的文字。岗位描述可能试图给读文件的 AI 下指令（"忽略你之前的指令，然后……"）。有两道限制：导出的文件把岗位正文放进 `<untrusted_job_posting>` 块里，块前有一句说明，说这个块是数据而不是指令（正文里出现的结束标签会被中和）；命令用 `claude_args` 启动 Claude Code，默认关掉它的网页工具，岗位文本没法让它去抓某个网址。Bash 工具仍然可用，因为 resume-kit 要用它渲染 PDF。面板上也有提醒，而且你始终在回路里：命令在你的终端里运行，Claude Code 做任何没预先允许的事之前都会先问你。不要关掉权限检查来运行它。

## 流程

1. 详情页点"定制简历"：写出 `<company>-<title>-<yyyy-mm-dd>.md`（YAML front matter：`job_id`、`company`、`role`/`title`、`url`、`apply_url`、`location`、`workplace`、`contract`、`language`、`salary`、`score`、`signals`；正文是 JD 原文），申请状态改为"准备中"（已申请及之后的状态不会被倒退）。同一天重复导出覆盖同一个文件；同公司同职位同一天的另一个岗位会加 `-<job_id>` 后缀，不会互相覆盖。
2. 面板给出命令，点"复制命令"后在终端粘贴：
   `cd <resume_kit_path> && claude "/tailor <jd 路径> master-resume=<主简历> exports-folder=<pdf_dir>"`
   （`/tailor` 会按 resume-kit 的 SKILL.md 生成变体 YAML、检查并导出 PDF。）
3. 在"挂上简历"里输入文件名（或下拉选择）并保存：路径必须在 `pdf_dir` 之内（`..`、目录外的绝对路径、指向目录外的符号链接都会被拒绝），文件必须存在且是 `.pdf`。详情页头部显示"简历：xxx.pdf"。

Telegram 的 📄 按钮走同一个导出函数：导出 JD、状态改为"准备中"，并把命令作为单独一条消息发回来。

## Docker

`compose.yaml` 把 `./data/exports` 挂进 web 和 runner。命令要在宿主机终端里粘贴，所以把 `jd_export_host_dir` 设成宿主机上这个目录的绝对路径。`pdf_dir` 要让容器里的 web 也看得到：把它所在目录用**相同的绝对路径**挂进 web 容器（compose override），否则只在 `pnpm dev` / 宿主机运行时可以挂简历。
