# 简历打印基线

每份文档有规范化提取文本（`<theme>.<sample>.txt`），页数记录在 `pages.json`。这些文件在 Linux 的 runner 镜像中生成。

在仓库根目录运行 `scripts/career-print-baseline-linux.sh <输出目录>`。脚本将 PDF 和文本写入输出目录，与本目录比较；有差异时以状态 1 退出。审核后，人工将获批的文本文件和 `pages.json` 复制到这里。脚本不会更新基线。

每次基线变更必须在 PR 中逐项解释差异，并经审核批准。不得直接用新输出替换基线。
