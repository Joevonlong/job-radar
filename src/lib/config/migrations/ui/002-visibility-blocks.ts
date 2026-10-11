import { isMap, isScalar, type Document } from "yaml";

import type { ConfigMigration } from "../types";

interface Block {
  key: string;
  value: unknown;
  /** Written above the key (zh first, as in the shipped file). */
  comment: string;
}

const BLOCKS: readonly Block[] = [
  {
    key: "applications",
    value: { hidden_statuses: [] },
    comment: [
      " 申请流程（设置 → 申请流程）：隐藏不用的申请状态。只影响显示：看板列、菜单、筛选、快捷键、Telegram 按钮不再列出它们；",
      ' 数据和服务器照常。"新"和"已忽略"不能隐藏。可隐藏的：interested | preparing | applied | interviewing | offer | rejected | withdrawn',
      " 隐藏的状态里还有卡片时，看板上显示成折叠的窄列，卡片仍可打开、改到别的状态。",
    ].join("\n"),
  },
  {
    key: "filters",
    value: { hidden_workplaces: [], hidden_contracts: [] },
    comment: [
      " /jobs 筛选里不列出的工作方式 / 合同类型（onsite | hybrid | remote；permanent | fixed_term | freelance | temp_agency | student）。",
      " 链接或保存的视图里已经选中的值照常生效。",
    ].join("\n"),
  },
  {
    key: "config_editor",
    value: { max_bytes: 262_144, backups_keep: 20 },
    comment: " 高级配置编辑器（设置 → 高级）\n max_bytes：编辑器接受的文本最大字节数；backups_keep：每个文件在 <用户目录>/.backup/editor/ 里最多保留几份备份",
  },
];

/** ui.yaml 1 → 2: the `applications`, `filters` and `config_editor` blocks, added with comments when the file lacks them. */
export const ui002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "adds the applications (hidden statuses), filters (hidden categories) and config_editor blocks",
  migrate(doc: Document) {
    if (!isMap(doc.contents)) return;
    const map = doc.contents;
    for (const block of BLOCKS) {
      if (map.has(block.key)) continue;
      const pair = doc.createPair(block.key, block.value);
      if (isScalar(pair.key)) {
        pair.key.commentBefore = block.comment;
        pair.key.spaceBefore = true;
      }
      map.items.push(pair);
    }
  },
};
