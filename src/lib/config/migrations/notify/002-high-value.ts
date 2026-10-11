/**
 * notify.yaml 1 -> 2: the lower push threshold no longer names the tiers T1/T2 but the high-value signal
 * categories of interests.yaml: `push_min_score_with_t1_t2` becomes `push_min_score_high_value` (same value). The
 * shipped comment above it is reworded; a comment the user wrote stays as it is.
 */
import { isMap, isScalar, type Document } from "yaml";

import type { ConfigMigration } from "../types";
import { pairOf, renameKey } from "../yaml-nodes";

const OLD_KEY = "push_min_score_with_t1_t2";
const NEW_KEY = "push_min_score_high_value";
/** The comment the shipped notify.yaml had above the old key (yaml keeps the space after `#`). */
const SHIPPED_COMMENT = " 带 T1/T2 薪酬信号的岗位门槛更低";
const NEW_COMMENT = " 带高价值信号（interests.yaml 里 high_value 的信号类别）的岗位门槛更低";

export const notify002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "push_min_score_with_t1_t2 -> push_min_score_high_value (the high-value signal categories of interests.yaml)",
  migrate(doc: Document): void {
    const root = doc.contents;
    if (!isMap(root) || !renameKey(root, OLD_KEY, NEW_KEY)) return;
    const pair = pairOf(root, NEW_KEY);
    if (pair && isScalar(pair.key) && pair.key.commentBefore === SHIPPED_COMMENT) pair.key.commentBefore = NEW_COMMENT;
  },
};
