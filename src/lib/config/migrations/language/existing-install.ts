/**
 * language.yaml for an install from before the language settings. Such an install ran in Chinese (interface, AI texts, Telegram,
 * doctor) with English one-line summaries next to the Chinese ones, and translated job ads into Chinese; this file keeps
 * exactly that. It is written instead of the shipped (English) default when `ensureConfigFiles` finds the user directory
 * already configured. The comments are Chinese because the owner of such an install reads Chinese: this is data for old
 * installs, not product copy.
 */
export const EXISTING_INSTALL_LANGUAGE_YAML = `# 语言（docs/settings.zh.md，设置 → 显示 → 语言）。语言代码按 BCP 47：en、zh、de、fr、pt-BR……
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
`;
