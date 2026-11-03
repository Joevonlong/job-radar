# shellcheck shell=bash
# What a restore needs to tell an archive from before the setup wizard (sourced; no node, no database). The texts and values
# are byte-identical to `src/lib/setup/existing-install.ts` and `src/lib/ops/config-archive.ts`; a test compares them.
#
#   existing_install_setup_yaml <iso-utc>   setup.yaml for such an archive: completed, so the wizard does not open
#   existing_install_language_yaml          language.yaml for such an archive
#   archive_meta_yaml                       the marker a new archive carries as data/config/.archive-meta.yaml
#   archive_setup_semantics <config dir>    prints the marker's value; returns 0, 2 (marker unreadable) or 3 (no marker)
#   archive_marker_check <tgz>              exactly one readable marker in the archive, else 1

# shellcheck disable=SC2034 # the test reads them
ARCHIVE_META_NAME=".archive-meta.yaml"
ARCHIVE_SETUP_SEMANTICS=2

existing_install_setup_yaml() {
  cat <<EOF
# First-run setup (docs/setup.md). This install had config files before the setup wizard existed, so it was marked
# complete on its first start. Open /setup (or run \`pnpm run setup\`) any time to walk through the steps again.
config_version: 1
completed_at: "$1"
completed_by: existing_install
EOF
}

existing_install_language_yaml() {
  cat <<'EOF'
# 语言（docs/settings.zh.md，设置 → 显示 → 语言）。语言代码按 BCP 47：en、zh、de、fr、pt-BR……
# 界面语言就是 messages/ 里的文件（en、zh，以及自己加的）；AI 输出和翻译可以是任何语言。
# 这个文件是升级时写入的，保持升级前的行为（全中文，摘要另附英文）。

config_version: 1

ui:
  # 浏览器没选过语言时的界面语言（语言菜单会按浏览器记住选择）
  default_locale: zh

ai:
  # AI 写的所有文字的语言：匹配理由、差距、一句话摘要、JD 拆解、兴趣建议理由。改了以后旧结果不重写，带语言标记
  output: zh
  # 一句话摘要另外再写哪些语言，切换界面语言时也有摘要可看
  summary_also: [en]

translation:
  # JD 翻译成什么语言；已经是这种语言的岗位没有翻译按钮
  target: zh

notify:
  # Telegram 消息的语言；null = 用 ui.default_locale
  locale: null

cli:
  # pnpm run doctor 和 pnpm sources:list 的语言；null = 用 ui.default_locale（--lang en|zh 可以临时覆盖）
  locale: null
EOF
}

archive_meta_yaml() {
  cat <<EOF
# Written by the backup into the config archive (docs/backup-restore.md). Not a config file.
# setup_semantics 2: a missing setup.yaml means the setup wizard is pending.
archive_meta_version: 1
setup_semantics: $ARCHIVE_SETUP_SEMANTICS
EOF
}

_archive_semantics_of_text() { # stdin: the marker's text. Prints the value; 1 when none can be read.
  local line
  line="$(grep -E '^setup_semantics: [0-9]+$' | head -n 1)" || return 1
  [[ -n "$line" ]] || return 1
  printf '%s\n' "${line#setup_semantics: }"
}

archive_setup_semantics() {
  local file="$1/$ARCHIVE_META_NAME"
  [[ -e "$file" || -L "$file" ]] || return 3
  [[ -f "$file" && -r "$file" ]] || return 2
  _archive_semantics_of_text <"$file" || return 2
}

archive_marker_check() {
  local member="data/config/$ARCHIVE_META_NAME" count
  count="$(tar -tzf "$1" | grep -cxF "$member")" || return 1
  [[ "$count" == 1 ]] || return 1
  tar -xzOf "$1" "$member" | _archive_semantics_of_text >/dev/null
}
