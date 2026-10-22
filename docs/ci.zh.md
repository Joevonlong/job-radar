# 持续集成（CI）说明

[English](ci.md) | [中文](ci.zh.md)

本页说明 GitHub Actions 流水线（`.github/workflows/ci.yml`）里每个任务（job）和每个步骤（step）：做什么、跑哪些测试和为什么、大概多久、怎么在本机复现、失败了怎么读。面向贡献者和维护者。

**本页与流水线绑定。** `pnpm ci:docs-check`（包含在 `scripts/validate.sh` 里，也是流水线自己的 `ci-docs` 任务）会在下列情况下失败：workflow 里的某个任务或步骤在本页没有对应小节；本页写了已经不存在的任务或步骤；[ci.md](ci.md)（英文主版）和本页列出的任务、步骤不一致。改流水线，就要在同一个 PR 里同时改 `docs/ci.md` 和本页。标题的写法见末尾“让本页保持准确”。

耗时是 GitHub 托管的 `ubuntu-24.04` runner（2 核）上的典型值，每个 PR 的运行摘要里有实际数字。本页有意不写测试数量和 action 版本号：它们随每个 PR 或 Dependabot 升级而变，以 workflow 文件和测试目录为准。

## 总览

```mermaid
flowchart LR
  PR([pull request / 推送到 main / 手动运行]) --> changes
  PR --> ci-docs
  PR --> static
  PR --> unit
  changes -- 代码有改动 --> integration
  changes -- 代码有改动 --> e2e
  changes -- 代码有改动 --> linux-smoke
  changes -- 部署相关有改动 --> upgrade-transition
  changes --> ci-ok
  ci-docs --> ci-ok
  static --> ci-ok
  unit --> ci-ok
  integration --> ci-ok
  e2e --> ci-ok
  linux-smoke --> ci-ok
  upgrade-transition --> ci-ok
  ci-ok --> merge([唯一需要的必过检查])
```

所有任务并行，总时长取决于最慢的那个（端到端任务，约 10 到 12 分钟），而不是相加。`ci-ok` 是分支保护应当要求的唯一检查：只有分类器选中的所有任务都成功，它才通过。

跑哪些任务由 `changes` 任务按改动内容决定：

| 改动 | 运行的任务 |
|---|---|
| 只改文档的 PR（`*.md`、`*.html`、图片；`tests/`、`src/`、`public/` 下的文件不算文档） | `changes`（含文档链接检查）、`ci-docs`、`static`、`unit`、`ci-ok`。有些单元测试会读文档（链接目标、图片大小），所以 `unit` 要跑。 |
| 其他 PR（代码、脚本、配置、`tests/`、`src/`、`public/` 下任何文件、workflow、Dockerfile） | 上面的再加 `integration`、`e2e`、`linux-smoke` |
| 改到部署相关文件的 PR（`scripts/ops/`、`src/ai-worker/`、`compose.yaml`、`Dockerfile`、`tests/transition/`、`tests/ops/sim/`） | 上面的再加 `upgrade-transition` |
| 推送到 `main` | 无论改了什么，一律全部；`integration` 还会按默认文件顺序再跑一遍 |
| 手动运行（`workflow_dispatch`） | 全部，同推送到 `main` |

没被选中的任务（只改文档的 PR 上的 `integration`、`e2e`、`linux-smoke`）显示为 skipped，`ci-ok` 只接受这种情况；必须运行却被跳过、取消或失败的任务会让 `ci-ok` 失败。

workflow 级设置：`permissions: contents: read`（任何任务都不能写仓库；来自 fork 的 PR 没有密钥）；每个 ref 一个 `concurrency` 组（新的推送会取消 PR 上较早的运行，但不会取消 `main` 上的运行）；每个任务和步骤都有 `timeout-minutes`，卡住的步骤会失败，而不是挂几个小时。

## 怎么读一次失败的运行

1. 打开 PR 的检查列表：只要有任务是红的，`ci-ok` 就是红的。要打开的是红色的那个任务。
2. 任务里红色的步骤默认展开。PR 注解（`::error::` 行、Playwright 的 `github` reporter）也出现在 “Files changed” 页和运行摘要里。
3. `e2e` 失败时，产物 `playwright-report`（保留 7 天）里有主测试集（`playwright-report/`）和设置向导测试集（`playwright-report-setup/`）的 HTML 报告以及失败测试的 trace：`pnpm exec playwright show-report playwright-report`（或 `playwright-report-setup`），单个 trace 用 `pnpm exec playwright show-trace <trace.zip>`。
4. 只有重试才通过的测试会让任务失败（`--fail-on-flaky-tests`），这是有意的：修掉不稳定的原因，不要重跑到变绿。
5. 只有原因明显出在 runner 上（网络、缓存服务）时才点 “Re-run failed jobs”，不要用它绕过失败的测试。

各步骤常见原因见下面各节。

## 任务

### Job `changes`

决定其他任务要不要跑，并检查文档里的相对链接。每次改动都会运行。上限 5 分钟，通常不到 20 秒。

#### Check out the repository

`actions/checkout`，`fetch-depth: 0`（完整历史，因为分类器要对比两个提交）。只会因 GitHub 故障失败。

#### Classify the change

只对 pull request 分类，写出其他任务读取的三个输出：

- `code`：只要有一个改动文件不是文档（`*.md`、`*.html`、`png`、`jpg`、`svg`、`gif`）就是 `true`。`tests/`、`src/`、`public/` 下的任何文件都算代码，即使是 HTML、SVG 或图片：测试会读自己的 fixture，应用也自带图片和页面。脚本、YAML、Dockerfile、workflow 同样是代码。`code` 选中 `integration`、`e2e` 和 `linux-smoke`；`static` 和 `unit` 无论如何都跑（单元测试会读文档，这里也不维护“哪些测试读哪些文件”的清单，免得过时）。
- `full`：推送到 `main` 和手动运行时为 `true`，会多跑一遍默认顺序的集成测试。
- `transition`：有改动路径以 `scripts/ops/`、`src/ai-worker/`、`tests/transition/`、`tests/ops/sim/` 开头，或者是 `compose.yaml`、`Dockerfile` 时为 `true`，选中 `upgrade-transition`。

推送到 `main` 和手动运行完全不分类：两者都写 `code=true`、`full=true`、`transition=true`。`main` 上的提交就是要部署的内容，所以只改文档的推送不能留下一次什么都没检查的运行。PR 的对比范围是 `base...head`，不做改名检测，所以被移动的文件新旧路径都会计入。算不出差异时这一步会失败（`ci-ok` 随之失败），不会悄悄当作“没改动”。手动复现：`git diff --name-only --no-renames origin/main...HEAD`，再看有没有不是 `*.md`、`*.html` 或图片的路径，或以 `tests/`、`src/`、`public/` 开头的路径。

#### Documentation links

`node scripts/check-doc-links.mjs`（即 `pnpm docs:check`，也在 `scripts/validate.sh` 里）。检查 Markdown 里的每个相对链接和 HTML 指南里的每个 `href` / `src` 是否指向存在的文件；不跟踪锚点和绝对 URL。约 5 秒。失败时列出 `文件 -> 目标`。常见原因：文档被改名或删除、相对路径写错。

### Job `ci-docs`

运行 `pnpm ci:docs-check`，让本页和流水线保持同步。它是单独的任务，因此只改文档的 PR 也会跑（删掉本页的一个标题就是只改文档的改动）。约 1 分钟，大部分是依赖安装（有缓存）。

#### Check out the repository

`actions/checkout`。

#### Set up pnpm

`pnpm/action-setup`：安装 `package.json` 的 `packageManager` 固定的 pnpm 版本。

#### Set up Node.js

`actions/setup-node`，Node 22（`engines` 里的版本），pnpm store 按 `pnpm-lock.yaml` 的哈希缓存。

#### Install dependencies

`pnpm install --frozen-lockfile`。`package.json` 和 `pnpm-lock.yaml` 不一致时失败：本地 `pnpm install` 后提交 lockfile。所有跑项目代码的任务都有这一步，下面不再重复解释。

#### CI documentation matches the workflows

`pnpm ci:docs-check`（`scripts/check-ci-docs.ts`）。解析 `.github/workflows/` 下每个文件，要求每个步骤都有 `name:`，并把任务和步骤与 `docs/ci.md` 的标题对比；还会对比 `docs/ci.zh.md` 和 `docs/ci.md` 的任务、步骤标题，并检查每个 Dependabot ecosystem 都在 [Dependabot](#dependabot) 一节里出现。每条报错都会说该添加、改名或删除哪个标题。它自己的测试是 `tests/ops/ci-docs-check.test.ts`。本地运行 `pnpm ci:docs-check`（一两秒）。

### Job `static`

不需要数据库和浏览器的检查：生成文件、lint、类型、配置、shell 语法、runner 打包、迁移漂移、Python sidecar 测试。每次改动都会运行。上限 15 分钟，通常 4 到 6 分钟（安装、lint、typecheck 占大头）。除 runner 打包、迁移漂移和 sidecar 测试外，其余都在 `scripts/validate.sh` 里。

#### Check out the repository

`actions/checkout`。

#### Set up pnpm

`pnpm/action-setup`。

#### Set up Node.js

`actions/setup-node`，Node 22，pnpm store 缓存。

#### Install dependencies

`pnpm install --frozen-lockfile`（见 `ci-docs`）。

#### I18n catalog (messages valid, generated files current)

`pnpm i18n:check`（`tsx scripts/i18n-catalog.ts --check`）。校验每个 `messages/<id>.json`（核心语言 `en`、`zh` 必须有全部 key，其他语言不能有英文没有的 key，每条消息的占位符必须与英文一致），并确认生成文件与生成器现在会写出的内容一致。报错会点出 key 或文件。修复：改 messages 后运行 `pnpm i18n:catalog`，提交重新生成的文件。几秒钟。

#### Lint

`pnpm lint`（`eslint .`），覆盖整个仓库，包括测试和脚本。失败时打印 `文件:行 规则`。规则允许时本地用 `pnpm lint --fix`。约 1 分钟。

#### Typecheck

`pnpm typecheck`（`tsc --noEmit`，严格模式，覆盖 `src`、`tests`、`scripts`、`e2e`）。抓类型错误以及背后的坏 import。约 1 分钟。

#### Config check

`pnpm config:check`（`tsx scripts/config-check.ts`）。按 schema 和 `config_version` 校验 `config/` 里每个随包默认值、每个 market pack，以及跨文件引用（例如 `preferences.yaml` 的市场能解析）。几秒钟。常见原因：配置改动违反了 zod schema。见 [configuration.zh.md](configuration.zh.md)。

#### Shell script syntax

`for f in scripts/*.sh scripts/ops/*.sh scripts/ops/lib/*.sh tests/ops/*.sh tests/ops/proc-lib/*.sh; do bash -n "$f"; done`。只做语法解析，覆盖运维脚本（部署、备份、恢复、worker 安装、validate）、它们 source 的库和 shell 测试脚本。脚本的行为由 `tests/ops/` 测试。瞬间完成。

#### Process library cases (bash 3.2)

`docker run --rm -v "$PWD":/w -w /w bash:3.2@sha256:0fd7cb8499c63a3c9345e7088a9cd83bb69f6e895e83833859aff838a0312091 bash tests/ops/proc-lib/cases.sh`。

`scripts/ops/lib/proc.sh` 让部署脚本里每个会改状态的命令在自己的进程组里运行，收到 INT / TERM / HUP 时只记下来，跑完当前这一步再停，并统一退出码。它的用例（新进程组、三种信号下的管道和孙进程、协作式子进程、退出码归一、两条“信号和子进程同时结束”的竞态各跑 60 次、拒绝 POSIX 模式、`VAR=value proc_run`）在这里用 bash 3.2（macOS `/bin/bash` 的版本）跑一遍。官方 `bash` 镜像按 digest 固定；它们基于 alpine 和 busybox，所以 `cases.sh` 只用 `bash`、`sh`、`uname`、`sleep`（要支持 `0.05`）、`cat`、`tr`、`grep`、`mktemp`、`rm`、`seq` 和可读的 `/proc`，开头逐个核对，缺任何一样就打印 `FAIL: missing <工具>` 并失败，不跳过。伪终端里的 `tostop` 用例和用真 pnpm 的进程组用例要 `script`、`node`、`pnpm`，在 unit 任务里由 `tests/ops/proc-lib.test.ts` 运行。约 30 秒。本地：同一条命令，或者 `bash tests/ops/proc-lib/cases.sh`。

#### Process library cases (bash 5.2)

`docker run --rm -v "$PWD":/w -w /w bash:5.2@sha256:a54fb4422b18f05dd3107c36f39d67b26334fda7ec89f4126052b45e228e2f15 bash tests/ops/proc-lib/cases.sh`。

同样的用例，用 bash 5.2 跑。竞态用例在这里最要紧：子进程恰好在 trap 打断 `wait` 时结束，bash 5.2 的 `wait` 返回 255；`proc_run` 用 `kill -0` 轮询、只 `wait` 一次来避开。约 30 秒。

#### Runner bundle

`pnpm build:runner`：用 esbuild 把采集器（`src/runner/index.ts`、`src/runner/healthcheck.ts`）打包到 `dist/`，和 Dockerfile 的 `runner` 目标一致。e2e 用的是替身 runner，所以真实 runner 入口的坏 import 只会在这里（早于镜像构建）被发现。约 20 秒。

#### Migration drift

运行 `pnpm exec drizzle-kit generate`，如果 `drizzle/` 下有任何变化就失败：`src/lib/db/schema.ts` 必须与已提交的迁移一致。失败时打印改动文件和 `::error::src/lib/db/schema.ts and drizzle/ disagree`。修复：`pnpm db:generate --name <slug>`，提交生成的 SQL 和 `drizzle/meta` 里的 journal。不要手改生成的 SQL 来消除报错。

#### Set up Python

`actions/setup-python`，Python 3.12，pip 缓存以 `jobspy/requirements*.txt` 为键。

#### Install jobspy sidecar dependencies

在 `jobspy/` 里 `python -m pip install -r requirements-dev.txt`，安装 sidecar 的运行依赖和测试依赖。本地请用虚拟环境：`python3.12 -m venv .venv && .venv/bin/pip install -r jobspy/requirements-dev.txt`。

#### Jobspy sidecar tests

在 `jobspy/` 里 `python -m pytest -q`（`jobspy/tests/` 里的测试，抓取库被 mock：请求校验、结果映射、`jobspy/app.py` 这个小 HTTP 服务的错误处理）。几秒钟。常见原因：改了 `jobspy/app.py` 没改测试，或依赖升级。

### Job `unit`

Vitest 单元测试：`tests/**`（除 `tests/integration/`）下的所有测试，组件用 jsdom，服务端代码用 node 环境。整套单跑约 4 分钟，所以用 Vitest 的 `--shard` 拆成两个并行任务 `unit (1/2)` 和 `unit (2/2)`（各约 2 到 3 分钟）。`fail-fast` 关闭，两个分片都会报告。每次改动都会运行，只改文档的 PR 也一样：有些测试会读仓库文档（界面帮助链接指向的标题、README 展示的图片及其大小）。上限 15 分钟。

这些测试不需要数据库、网络和真实时钟：时间是注入或伪造的，配置在每个测试里用临时目录构造，冻结的 fixture `tests/fixtures/config/defaults/` 代替随包的 `config/`（测试从不断言随包默认值）。

#### Check out the repository

`actions/checkout`。

#### Set up pnpm

`pnpm/action-setup`。

#### Set up Node.js

`actions/setup-node`，Node 22，pnpm store 缓存。

#### Install dependencies

`pnpm install --frozen-lockfile`。

#### Unit tests

`pnpm test --shard=<n>/2`，即对一半文件执行 `vitest run`。本地全跑用 `pnpm test`，单个文件 `pnpm test tests/ops/backup.test.ts`，单个测试加 `-t "<名称>"`。文件落在哪个分片由 Vitest 按文件列表决定，增删文件后失败的文件可能换分片。失败输出是 Vitest 的：测试名、期望与实际的差异、行号。常见原因：没 mock 时钟；依赖时区或其他测试遗留状态（单独重跑该文件就能分辨）；断言了随 messages 变化的文案。

### Job `integration`

需要真实 PostgreSQL 17 的测试：仓库层与迁移、周期与队列、控制请求、ai-worker、仪表盘查询、用真实 `pg_dump` / `pg_restore` 的备份。`tests/integration/` 下的文件，通过 `vitest.integration.config.ts` 运行（node 环境，文件依次运行，因为共用一个在每个文件前后都被清空的数据库）。上限 45 分钟，通常 3 到 4 分钟，另加 worker 替换测试约 16 分钟。

任务带一个 `postgres:17` service 容器，环境变量 `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`。该角色可以建库：每次运行创建一个唯一命名的数据库（`tests/integration/global-setup.ts`），结束时删除，服务器上其他东西不受影响。这些测试没有默认服务器：没设 `DATABASE_URL` 时运行立即停止并打印一次性容器的命令，所以本地运行不可能连到你自己安装的数据库。`REQUIRE_PG_TOOLS=1` 让备份测试在缺客户端工具时失败而不是跳过。

#### Check out the repository

`actions/checkout`。

#### Set up pnpm

`pnpm/action-setup`。

#### Set up Node.js

`actions/setup-node`，Node 22，pnpm store 缓存。

#### Install dependencies

`pnpm install --frozen-lockfile`。

#### Provide PostgreSQL 17 client tools

把 `pg_dump` 和 `pg_restore` 建成指向 `scripts/ops/pg-docker.sh` 的符号链接，它在 `--network host` 容器里用 `postgres:17` 镜像里的工具（所以 `localhost:5432` 能连上）。客户端和服务端必须同一大版本；工具取自 service 已经拉取的镜像，避免用 `apt.postgresql.org`（它曾让这一步卡了一小时）。最后打印两个版本作为冒烟检查。本地 Linux 上做法相同（`ln -sf "$PWD/scripts/ops/pg-docker.sh" /tmp/pgbin/pg_dump`，`pg_restore` 同理），并导出 `PG_DUMP_PATH`、`PG_RESTORE_PATH`；macOS 的 Docker Desktop 没有 host 网络，装 PostgreSQL 17 客户端工具（如 `brew install postgresql@17`）并把这两个变量指过去。

#### Integration tests (default order)

`pnpm test:integration --reporter=verbose`，只在 `full` 为 true 时运行（推送到 `main`、手动运行）。verbose reporter 会在每个文件开始时打印它，卡住的文件因此能被点名。两个 worker 替换测试文件不在这里跑（`--exclude`），它们有下面单独的一步。上限 15 分钟。本地怎么跑见 [本地跑完整流水线](#本地跑完整流水线)。

#### Integration tests (shuffled file order)

用 `--sequence.shuffle.files --sequence.seed=<seed>` 跑同一套测试；seed 以 `::notice::` 注解打印（`integration file order seed: N`）。PR 只跑这种顺序：它能发现依赖其他文件遗留状态的文件，固定顺序会掩盖这类问题。复现失败：用注解里的 seed 运行 `pnpm test:integration --sequence.shuffle.files --sequence.seed=<seed>`。这里同样不跑两个 worker 替换测试文件。上限 15 分钟。

#### Worker switch and uninstall tests (service-manager simulator)

`tests/integration/ai-worker-swap.test.ts` 和 `tests/integration/uninstall-ai-worker.test.ts`，按默认顺序跑一次：`scripts/ops/install-ai-worker.sh`（在发布目录之间替换、回滚、信号、数据库 URL 各种写法）和 `uninstall-ai-worker.sh`，对着服务管理器模拟器 `tests/ops/sim`（`launchctl` 和 `systemctl --user` 的替身，真的启动进程，状态存在一个 JSON 文件里），launchd 和 systemd 各一套。假 worker（`tests/fixtures/release/fake-worker.mjs`）在独立的数据库里拿锁、写 heartbeat。大多数用例要等停止或证据超时（脚本的下限：10 秒和停止时间加 10 秒），所以这一步约 16 分钟，只跑一次，不在两种顺序里各跑一遍。上限 25 分钟。本地：同样的命令加一个一次性数据库；不会真的安装任何东西（临时的 `HOME` 和 `XDG_CONFIG_HOME`）。

#### Set up the lowest Node.js of engines.node

再用一次 `actions/setup-node`，这次是 Node 22.23.4，即 `engines.node`（`>=22.23.4 <23`）允许的最低版本。宿主机 ai-worker 的发布目录守卫（`src/ai-worker/release-guard.mjs`）需要 Node 的同步模块 hook，tsx 从 22.22.3 起才走这条路；22.23.4 是带有 2026 年 10 月 Node 安全修复的下限。这是任务的最后几步，之后没有别的步骤用这个 Node。

#### Load a release module with the lowest Node.js

在临时目录的一个 clone 里，用 `scripts/ops/prepare-release.sh --offline` 为当前提交建发布目录（安装依赖那一步之后 pnpm store 里已经有全部包），再像 ai-worker 服务那样，在发布目录里经守卫和 tsx loader 加载其中一个 `.ts` 模块（tsx 从发布目录的 `tsconfig.json` 读路径别名）。退出码不为 0，或者 stderr 里有 `module.register called`（tsx 走了 hook 线程那条路，守卫会拒绝），这一步就失败。上限 5 分钟。本地：切到 Node 22.23.4，在临时目录里执行 workflow 里同样的命令，`--root` 绝不要指向你安装用的 checkout。

### Job `e2e`

Playwright 浏览器测试，对生产构建（`pnpm build` 再 `pnpm start`）、一次性的 PostgreSQL 17 service 和替身 runner（`scripts/e2e-runner.ts`：心跳、配置确认、控制请求轮询，使“立即运行一轮”和“配置已保存”无需真实采集器即可工作）运行。没有 AI 提供方，没有职位通道，除 localhost 外没有网络。`e2e/` 下的 spec，另有 `e2e-setup/` 的 spec。上限 20 分钟，总共通常 10 到 12 分钟。任务跑在 runner 主机上，不在 Playwright 容器镜像里（实测镜像更慢）。

环境：`DATABASE_URL` 指向 service（本地运行必须自己设 `DATABASE_URL` 或 `E2E_ADMIN_DATABASE_URL`：没有默认地址）；`scripts/e2e-prepare.ts` 拒绝任何名字不以 `jobradar_e2e` 开头的数据库，它创建数据库 `jobradar_e2e_3100`（名字随 `E2E_PORT`），应用迁移，加载仪表盘种子（虚构职位），并用 `tests/fixtures/config/defaults/` 的冻结 fixture 填充全新的配置和 profile 目录。`E2E_PORT=3100` 是服务端口；`E2E_SKIP_BUILD=1` 告诉 web server 命令不要再构建。

**主测试集的 project（`playwright.config.ts`）。** spec 并不都以同一种方式运行：

project 的规划在 `e2e/projects.ts`（由 `tests/e2e-projects.test.ts` 做单元测试，它还用 `playwright test --list` 核对点名的 spec 只跑它自己）。

- `chromium` 让大部分 spec 完全并行（2 核 runner 上 2 个 worker），各用自己的浏览器 context。它忽略所有会写共享配置的 spec，以及所有带 `@exclusive` 标签的测试。
- `chromium-exclusive` 在 `chromium` 全部结束后，一次一个（`workers: 1`）运行带 `@exclusive` 标签的测试。所有 spec 共用一个预置数据的数据库，并行的 spec 一边跑一边改它：打开详情页会把岗位标为已看，访问“今日”会移动“上次访问”标记，有的测试会忽略、关闭、收藏岗位（再改回去），scoring spec 会临时插入一个岗位。改动每个页面都会读的状态（访问标记、所有岗位的已看记录：`list-today.spec.ts`），或比较整个列表计数的测试（`dashboard.spec.ts` 里 `/jobs` 筛选的计数、`filter.spec.ts` 的已过滤开关、`insights.spec.ts` 的头部数字）要加这个标签。只改一个岗位的测试用一个别的 spec 不碰的岗位、事后改回，并只对这个岗位断言，它留在并行 project 里。
- 会改写同一个共享配置目录里文件的 spec（settings、language、breakdown、resume、interests、sources、market）会互相破坏，或破坏并行 spec 里读取这些设置的断言（Sources 页的 AI 卡片、界面语言）。所以它们作为单 spec 的 project，用 `dependencies` 串成链，一个接一个，且在 `chromium-exclusive` 全部结束之后才开始。按顺序如下：
  - 配置链：`chromium-config-settings`、`-settings-invalid`、`-language`、`-breakdown`、`-resume`。
  - interests 链：`chromium-interests`、`chromium-interests-suggestions`、`chromium-multi-filters`（都会把视图或接受的建议存到唯一的 `interests.yaml`）。
  - sources 链：`chromium-sources-registry` 和 `chromium-sources-discovery`（都改写 `sources.yaml`）。
  - settings 链：`chromium-settings-advanced` 和 `chromium-settings-workflow`（高级编辑器和工作流标签页改写 ui、notify、ai、sources、pipeline 配置）。
  - `chromium-deal-breakers`（改写 `preferences.yaml` 的 `deal_breakers` 和一个岗位的过滤结果）。
  - `chromium-visa`（改写 `me.yaml` 的 `needs_visa_sponsorship`）。
  - 最后是 `chromium-market`（切换市场会改变每个页面和 `preferences.yaml`）。

所以总时长不是“最慢 spec 除以 2”：这条链是有意串行的。
- 新 spec 只要写配置目录里的任何文件，就必须加进 `e2e/projects.ts` 的 `SERIAL_CHAIN`（拥有自己的串行 project），否则会与其他 spec 并行而随机失败。新测试如果改共享的数据库状态或计数整个列表，加 `{ tag: EXCLUSIVE_TAG }`。
- 每个 spec 都从 `e2e/fixtures.ts` 导入 `test` 和 `expect`，不直接从 `@playwright/test` 导入（否则 `pnpm lint` 报错；只导入类型可以）。它的页面不会在 Server Action 还没完成时离开：`goto`、`reload`、`goBack`、`goForward`、`close`、`context.close()` 和每个测试结束时，都先等到该 context 各页面发出的 action 请求的响应全部收完（最多 15 秒，超时就报错并写出是哪个 action）。没有这一步，乐观更新之后马上刷新会取消保存，刷新后的页面与刷新前矛盾。要用别的方式读已保存的状态（数据库、配置文件）时，先调用 `waitForServerActions(page)` 或轮询。`E2E_SERVER_ACTION_DELAY_MS=<毫秒>` 让每个 action 请求延迟这么久再发出，用来暴露保护没覆盖的导航路径和直接读取已存储状态（数据库）而没先等待的地方，让它们每次都失败；它抓不到绕开 fixture 的导入（那由 lint 规则管，动态导入以及 `playwright` / `playwright-core` 也在内）。未覆盖的范围：页面自己发起的整页导航（点链接、提交表单）、`page.setContent()`、`browser.close()`，以及测试从不关闭的 `browser.newContext()` 创建的 context（只有 `context` fixture 在测试结束时等待）。保护从 `fetch` 调用起才看得到 action，之前的瞬间很短但不在覆盖内，所以最后一个 action 结束后还要安静 400 毫秒；`e2e/server-action-guard.spec.ts` 测试这个保护本身。
- 命令行上点名的 spec 文件（`pnpm test:e2e e2e/settings.spec.ts`）只跑它们自己：只有含匹配 spec 的 project 参与，每个都收窄到点名的 spec，顺序仍按上面。（Playwright 会完整运行依赖 project，没有这一步时，链上的 spec 会先把整个并行套件跑一遍。）带 `file:line` 时，选中的 project 不再串起来，只跑那几行的测试。`--project <名称>` 仍会先跑它的依赖；要单独跑加 `--no-deps`。
- CI 里 `retries` 是 1，reporter 是 `github`、`list`、`html`；`forbidOnly` 拒绝提交 `test.only`。

**设置向导测试集（`playwright.setup.config.ts`）** 单独运行，因为它需要另一个世界：全新安装。它有自己的端口（`E2E_SETUP_PORT`，默认 3105）、自己的数据库（`jobradar_e2e_setup_<port>`，由 `scripts/e2e-prepare.ts --fresh` 删除、重建并只迁移不灌种子）、空的配置和 profile 目录，且没有替身 runner（请求的周期保持排队）。与主测试集不同，它不用冻结的 fixture：默认目录就是随包的 `config/`（含示例 profile），与首次 `docker compose up` 的起点完全一致，因此是产品契约测试，随包默认值的改动若破坏了首次运行体验，它会失败。1 个 worker、按顺序执行，因为这些 spec 在同一个安装上依次走完向导。

#### Check out the repository

`actions/checkout`。

#### Set up pnpm

`pnpm/action-setup`。

#### Set up Node.js

`actions/setup-node`，Node 22，pnpm store 缓存。

#### Install dependencies

`pnpm install --frozen-lockfile`。

#### Cache Playwright browsers

`actions/cache`，缓存 `~/.cache/ms-playwright`，键为 runner 系统加 `pnpm-lock.yaml`（浏览器版本跟随锁定的 `@playwright/test`）。设置 `steps.playwright-cache.outputs.cache-hit`。

#### Install Playwright browser and system libraries

`pnpm exec playwright install --with-deps chromium`，只在缓存未命中时运行。下载 Chromium 并（用 apt）安装它需要的系统库。最多一分钟左右。

#### Install Playwright system libraries

`pnpm exec playwright install-deps chromium`，只在缓存命中时运行：缓存里只有浏览器，没有系统库，所以每次都要装系统库。

#### Cache the Next build cache

`actions/cache`，缓存 `.next/cache`（只是 Next 的增量构建缓存；应用始终从当前源码构建）。键包含 lockfile 以及 `src/`、`messages/`、`next.config.ts` 的哈希，回退键只有 lockfile。

#### Build

`pnpm build`（先生成 i18n catalog，再 `next build`）。产出服务启动所用的生产构建。允许最多 8 分钟。这里失败说明应用有 `static` 任务没发现的编译或类型错误（例如服务端 / 客户端边界违规）。

#### End-to-end tests

`pnpm test:e2e --workers=2 --fail-on-flaky-tests`：如上所述的主测试集所有 project。web server 命令先运行 `scripts/e2e-prepare.ts`，再 `pnpm start -p 3100 -H 127.0.0.1`。只有重试才通过的测试会让任务失败；重试仍会为报告记录 trace。上限 12 分钟。本地：先起一个一次性数据库（下文的 postgres 容器），`pnpm build`，然后 `E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e`；`E2E_PORT=<端口>` 让一次运行有自己的数据库和目录，多个检出可以并排运行，但**同一台机器同一时间只跑一套完整 e2e**：并行的完整运行会互相抢资源，产生并非真实失败的超时。开发时只跑受影响的 spec（`pnpm test:e2e e2e/pipeline.spec.ts`、几个文件，或 `e2e/dashboard.spec.ts:206` 只跑一个测试；只跑这些，web server 和替身 runner 照常启动），完整套件留给 CI。常见失败原因：定位器随界面文案变了（spec 以英文运行）；写共享配置的 spec 没加进 `SERIAL_CHAIN`；计数整个列表或改共享数据的测试没加 `@exclusive` 标签；只有 2 个 worker 才暴露的竞态（trace 里能看到）。

#### Setup wizard end-to-end tests

`pnpm test:e2e:setup --fail-on-flaky-tests`，在主测试集之后、同一份构建上、用自己的服务、数据库和目录运行（见上）。上限 6 分钟，通常 1 到 2 分钟。报告目录：`playwright-report-setup/`。

#### Upload the Playwright report and traces

只在本任务有步骤失败时运行（`if: failure()`）：把 `playwright-report/`（主测试集）、`playwright-report-setup/`（设置向导测试集）和 `test-results/` 上传为产物 `playwright-report`，保留 7 天。从运行页下载，用 `pnpm exec playwright show-report <目录>` 打开报告。

### Job `linux-smoke`

Linux 从零首次运行：在 Ubuntu runner 上用一份空的检出，按随附默认值 `docker compose up --build`，面板必须能应答。它能发现 macOS 上 Docker Desktop 掩盖的问题：bind mount 的文件属主（`PUID` / `PGID`）、以 0600 写入的配置文件、容器写不了的目录。它从 Dockerfile 构建 web、runner、jobspy 三个镜像，所以也是在部署之前发现 `apt` / CLI 安装失败、`COPY` 路径错误、构建阶段损坏的地方（不再有单独的只构建镜像的任务）。Dockerfile 用 `RUN --network=none` 编译 web 和 runner（构建阶段没有任何 `.next` 缓存），所以这次构建也证明编译不需要网络：字体来自 npm 包，构建时一旦访问互联网，任务就会失败。它和 `scripts/ops/deploy.sh` 一样，从解开的 `git archive` 构建镜像，并核对镜像里的出厂配置（`config/` 打进镜像，不再挂载），以及从工作树构建时 `.gitignore` 忽略的文件都进不了构建上下文。每个不是只改文档的 PR 和每次推送到 `main` 都会运行。上限 20 分钟，构建步骤 15 分钟；通常几分钟（冷构建，没有层缓存）。本地（Linux）：在一份新克隆里执行下面各步骤的命令（不要在你想保留其服务栈和数据库的检出里做：最后一步会删除服务栈和它的卷）。

#### Check out the repository

`actions/checkout`。

#### Prepare .env and the data folders as the host user

写一个只设 `PUID` / `PGID`（runner 自己的用户，`id -u`、`id -g`）的 `.env`，正如 [host-setup.zh.md](host-setup.zh.md) 要求 Linux 用户做的那样；并以该用户创建 `data/` 下的目录和 `.auth/`，避免 Docker 以 root 身份创建 bind mount 目录。

#### Unpack the commit as the build context

`git archive HEAD | tar -x -C "$(mktemp -d)"`，这个目录写进 `JOB_RADAR_BUILD_CONTEXT`，供后面的步骤使用。`compose.yaml` 从 `${JOB_RADAR_BUILD_CONTEXT:-.}` 构建 web、runner、jobspy，`scripts/ops/deploy.sh` 也是这样设置的，所以镜像里只有已提交的文件。瞬间完成。

#### Start the stack from scratch

`docker compose up -d --build --wait --wait-timeout 600`：构建 web、runner、jobspy 三个镜像并拉取数据库镜像，等到每个服务都报告健康（runner 会执行迁移并开始心跳）。这里失败要么是构建错误（日志会显示失败的 Dockerfile 行；常见原因：基础镜像仓库里的包移动了；`COPY` 的路径被 `.dockerignore` 排除；lockfile 变化后构建阶段 `--frozen-lockfile` 装不上），要么是某个服务一直没有变健康：“Container logs on failure”一步会打印原因。

#### Dashboard health check

`GET /api/health` 必须返回 200，`GET /`（页面导航）返回 200 或重定向到首次运行向导。

#### The web can write its config folder

在 web 容器里的 `data/config` 中创建并删除一个文件（设置页和向导会写这里），并检查 runner 能写 `data/backups`。失败说明容器用户不拥有 bind mount 的目录：检查 `compose.yaml` 的 `user:` 和 `PUID` / `PGID` 两行。

#### The images ship exactly the committed config

列出 web、runner 容器里 `/app/config` 下的文件，和 `git ls-files config` 比较（`diff -u`）。有差别说明 Dockerfile 的 `COPY config/ /app/config/` 或 `.dockerignore` 改变了进入镜像的内容。几秒钟。

#### The shipped config is read-only for every user

在每个容器里以容器自己的用户运行四条 `find`，都必须没有输出：`find /app/config ! -user root`（全部归 root 所有）、`find /app/config -perm /022`（组和其他用户都不能写）、`find /app/config -type f ! -perm -444`（每个文件所有人可读）、`find /app/config -type d ! -perm -555`（每个目录所有人可读、可进入）。失败说明 Dockerfile 里缺了 `RUN chmod -R a+rX,go-w /app/config`，或者它跑在后面某个 `COPY` 之前。几秒钟。

#### Nothing is mounted over the shipped config

对 web、runner 容器 `docker inspect`：任何挂载的目标都不能是 `/app/config`（或它下面的路径）。挂载在那里会挡住镜像里的配置；安装好的系统上 doctor（`config.shipped`）也会对此告警。瞬间完成。

#### Docker build context leaves out what .gitignore ignores

`bash tests/ops/gitignore-coverage.sh`。在一个放了 `.gitignore`、`.dockerignore` 副本的临时目录里，把 `.gitignore` 的每个条目变成根目录和子目录各一个样本文件（展开规则写在脚本开头；每个样本都先用 `git check-ignore` 确认 git 确实忽略它），用 `tests/fixtures/docker/context-list.Dockerfile`（`node:${{NODE_VERSION}}-slim`，`NODE_VERSION` 取自 Dockerfile，并在构建日志里核对）列出两个构建上下文，任何样本出现在上下文里就失败。否定条目（`!.env.example`、`data/` 的占位文件）在白名单里，各写明原因。失败时会列出漏进去的样本：把条目加进 `.dockerignore`，`.gitignore` 在任意深度匹配的，用 `**/` 写法。部署从 `git archive` 构建，看不到被忽略的文件；这一步覆盖的是 `pnpm stack:up` 和直接 `docker compose build`。约 10 秒。

#### Container logs on failure

仅当前面的步骤失败时运行：`docker compose ps -a` 和每个服务最后 200 行日志。

#### Remove the stack and its volume

总是运行：在一次性的 runner 上 `docker compose down -v --remove-orphans`。

### Job `upgrade-transition`

用真 Docker 和每个版本自己的 deploy、install、uninstall 脚本测升级迁移，ai-worker 跑在模拟的 systemd 下（`tests/transition/run.sh`）。`changes` 设了 `transition` 时运行（改到部署相关文件的 PR、每次推送到 `main`、手动运行）。没有 service 容器：脚本的每个 compose 项目自带数据库。上限 120 分钟，要构建镜像大约十次。

#### Check out the repository

`actions/checkout`，`fetch-depth: 0`：场景要检出更早的版本。

#### Set up pnpm

`pnpm/action-setup`。

#### Set up Node.js

`actions/setup-node`，Node 22，pnpm store 缓存。

#### Install dependencies

`pnpm install --frozen-lockfile`（发布目录从这个 pnpm store 安装依赖）。

#### Upgrade transition scenarios

`bash tests/transition/run.sh "$RUNNER_TEMP/transition"`。在临时目录下的 clone 里运行，每个 clone 有自己的 compose 项目（`jrtransition-<随机>-*`）、端口、卷和数据库密码，定时周期关闭：

- A：62d7ad9，然后按文档逐跳升级（4dd8d03、2656364、b3f69b0、检出的提交），每跳用该版本的 `deploy.sh --skip-pull`；升到 2656364 前先停 web 和 runner；最后一跳前按 `docs/upgrade.md` 的首次升级步骤做（卸载旧 worker，确认已停，停 web 和 runner，检出，部署）。
- B：62d7ad9；新的 `install-ai-worker.sh --release` 换上一个启动就抛错的发布，必须回滚到从 checkout 安装的 worker；换上正常的发布则成功；然后严格停止，部署检出的提交。
- D：runner 镜像构建失败的部署（构建参数 `FAIL_RUNNER_BUILD=1`）不改任何容器、镜像和 worker，也不留锁；去掉参数再部署成功。
- C：tsx loader 坏掉的发布被回滚。
- E：应急恢复上一个发布；doctor 报告 release != HEAD。最后卸载。

每一步之后：web 和 runner 容器里的 `/app/config` 等于所部署提交的 `config/`（逐文件 sha256）；worker 的 MainPID 在预期目录里运行，`install-ai-worker.sh --print-release` 一致；worker 完成一个 `run_ai` 请求；doctor 的 JSON（`--only config.shipped --only ops`）有 shipped config 检查，从发布目录版本起确认各进程的报告，并且没有锁和替换备份。安全措施：开始前清掉调用方环境里所有 compose、docker 和数据库相关变量（`COMPOSE_*`、`DOCKER_HOST`、`JOBRADAR_*`、`JOB_RADAR_*`、`POSTGRES_*`、`PG*`、`DATABASE_URL`，以及 compose 文件里插值用到的每个变量名），它们因此无法覆盖项目的 `.env`（`tests/transition/clean-env.sh`）。docker 包装（`tests/transition/docker-guard.sh`）放行只读命令；会改动东西的 compose 命令只对脚本自己的项目执行，而且要先让同一条命令的 `docker compose config` 通过 `tests/transition/compose-check.mjs`（每个卷都带本次运行的前缀且不是 external，每个 bind mount 和构建上下文都在本次运行的目录里，没有 `container_name`，只发布为该项目登记的端口）；`down`、prune 和 `volume rm` 一律拒绝。清理时用同样的方式检查配置和容器的挂载，执行不带 `-v` 的 `down`，只删除名字带项目前缀的卷。`launchctl` 和 `systemctl` 必须指向模拟器。`tests/ops/transition-guard.test.ts` 用假的 docker 测这些防护。上限 105 分钟。本地（Linux 或 macOS，Docker 带 compose v2）：同样的命令；结束时删除临时目录和脚本自己的 compose 项目、镜像、卷。

不覆盖：launchd（集成测试在 launchd 模拟器上测替换；真 launchd 靠手动演练），以及 `deploy.sh` 自己的 git pull（每跳先检出提交再用 `--skip-pull`）。不在 Linux 上时跳过 doctor 把 worker 报告和 systemd 对照的那部分。

#### Upload the transition logs

只在前面某一步失败时：worker 日志、模拟器的调用记录和每一步的输出，作为 artifact `upgrade-transition-logs`（保留 7 天）。

### Job `ci-ok`

唯一需要要求的检查。`needs` 列出所有其他任务，`if: always()` 让它即使其他任务失败或被跳过也会运行。上限 5 分钟，几秒钟。

#### All selected checks passed

读取 `needs` 的结果（`jq`）：`changes`、`ci-docs`、`static`、`unit` 必须始终成功（被跳过算失败，不算通过）；`integration`、`e2e`、`linux-smoke` 在 `changes` 选中代码时必须成功，否则必须是 skipped；`upgrade-transition` 按 `transition` 同样处理。其他任何组合（包括必须运行却被跳过或取消的任务）都会打印各任务结果和 `::error::a selected check did not succeed`。它变红时，先看它打印的各任务结果，再打开对应任务。

## Dependabot

`.github/dependabot.yml` 每周为三个生态系统开 PR：

| 生态系统 | 目录 | 说明 |
|---|---|---|
| `npm` | `/` | 最多 5 个未关闭 PR；字体包（`@fontsource/*`、`@fontsource-variable/*`）单独一个 PR（字体升级会改变所有页面的样子：合并前对比页面），其他 minor 和 patch 更新合并成一个 PR；忽略 `@types/node` 的 major 更新（类型跟随 `engines` 里的 Node 大版本） |
| `pip` | `/jobspy` | 最多 3 个未关闭 PR；sidecar 的 Python 依赖 |
| `github-actions` | `/` | 最多 3 个未关闭 PR；workflow 里固定的 action 版本 |

Dependabot 的 PR 和其他 PR 跑同一条流水线。action 升级会改 `.github/`，因此算代码，会跑全部任务；如果它改了步骤名，`ci-docs` 会失败，直到本页更新。本页不写 action 版本号，所以单纯升级版本不需要改文档。

## 发布检查

`scripts/release-check.sh` 不是流水线的一部分。维护者在仓库公开或发版之前手动运行，提交可疑时也可运行：对 git 会跟踪的每个文件和整个提交历史跑 gitleaks（通过 Docker，镜像版本固定）、扫描个人字符串和本机路径、检查 `.gitignore` 覆盖 `.env`、`data/`、`.auth/`，并检查仓库里没有私有规划编号（维护者跟踪系统里的编号：`F-`、`B-`、`ADR-` 加三位数字，`M-`、`P-` 加两位数字；`ADR` 不分大小写）既不在任何文件内容里也不在文件名里，仓库根目录的 `drizzle/` 和 `pnpm-lock.yaml`，以及 `scripts/planning-ids.allow` 里精确列出的 `路径` 或 `路径:行号`（编号是数据而不是引用）除外。这一项也可单独运行：`scripts/release-check.sh --planning-ids-only`（不需要 Docker，约一秒）；它是 `scripts/validate.sh` 的一部分，也由单元测试 `tests/ops/release-check-script.test.ts` 覆盖，所以编号回来时 CI 会失败。退出码 0 表示干净，1 列出问题，2 表示没能运行。它单独成关，因为需要 Docker 跑 gitleaks，还需要 CI 里没有的、未跟踪的本地模式文件。详见 [RELEASING.md](../RELEASING.md)。

## 本地跑完整流水线

上面每个任务都只是几条命令。下面是通用做法（有 Docker、Node 22 加 pnpm、Python 3.12 就够），使用一个端口与你真实数据库不同的一次性 PostgreSQL。

```bash
# 一次性数据库（角色可建库，与 CI 的 service 一样）。数据库相关的测试没有默认地址：没设 DATABASE_URL（e2e 也可以设
# E2E_ADMIN_DATABASE_URL）时它们会停下并打印这段做法，绝不会连到你自己安装的数据库。
docker run -d --name jr-ci-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:17
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres

pnpm install --frozen-lockfile

# 任务：changes（链接）、ci-docs、static、unit（第一条就是 scripts/validate.sh 做的事）
scripts/validate.sh            # shell 语法、i18n、lint、typecheck、单元测试、配置、文档链接、CI 文档
pnpm build:runner
bash tests/ops/proc-lib/cases.sh   # CI 另在固定 digest 的 bash:3.2、bash:5.2 镜像里各跑一遍（见该任务）
pnpm exec drizzle-kit generate < /dev/null && git status --porcelain -- drizzle   # 必须没有输出
(cd jobspy && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q)

# 任务：integration（需要大版本 17 的 pg_dump / pg_restore，见该任务的步骤）
export PG_DUMP_PATH=/path/to/pg_dump PG_RESTORE_PATH=/path/to/pg_restore REQUIRE_PG_TOOLS=1
pnpm test:integration --reporter=verbose
pnpm test:integration --sequence.shuffle.files --sequence.seed=$RANDOM

# 任务：e2e（本机同一时间只跑一套完整 e2e）
pnpm exec playwright install chromium
pnpm build
E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e --workers=2 --fail-on-flaky-tests
E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e:setup --fail-on-flaky-tests

# 任务：linux-smoke（Linux，只在新克隆里做：最后会 `docker compose down -v`；它会构建 web、runner、jobspy 三个镜像）
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" > .env && mkdir -p data/{config,profile,backups,exports,logs} .auth
export JOB_RADAR_BUILD_CONTEXT="$(mktemp -d)" && git archive HEAD | tar -x -C "$JOB_RADAR_BUILD_CONTEXT"
docker compose up -d --build --wait --wait-timeout 600 && curl -fsS http://127.0.0.1:3000/api/health
bash tests/ops/gitignore-coverage.sh
docker compose down -v --remove-orphans

docker rm -f -v jr-ci-pg
```

本地运行与托管流水线有三点不同：测的是你的工作区，而不是 PR 与 `main` 合并后的结果；用的是你自己的 Docker 和 Node 版本；不会自己判断跳过什么（只改文档时，托管流水线会做 `pnpm docs:check`、`pnpm ci:docs-check`、static 检查和单元测试）。

## 让本页保持准确

- workflow 的每个任务需要一个标题 ``### Job `<任务 id>` ``（`jobs:` 下的 key；任务 id 在所有 workflow 里唯一），它的每个步骤在其下面需要一个标题 `#### <步骤名>`，拼写与步骤的 `name:` 完全一致。每个步骤都必须有 `name:`，只运行 action 的步骤（checkout、setup）也一样。
- “任务”部分里，`###` / `####` 标题只用于任务和步骤；额外说明写在步骤下面、任务的介绍里或加粗段落里。
- `.github/dependabot.yml` 的每个 ecosystem 都要在“Dependabot”一节里用反引号提到。
- `docs/ci.zh.md` 的任务和步骤标题与 `docs/ci.md` 相同（保持英文，因为它们是标识符），正文翻译。
- 运行 `pnpm ci:docs-check`；它会打印该添加、改名或删除哪个标题。
