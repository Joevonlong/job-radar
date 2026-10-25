import { isMap, isScalar, type Document } from "yaml";

import type { ConfigMigration } from "../types";

export const salary002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "removes benchmark.include_ai_lookups (AI salary lookups never count in the salary benchmark)",
  migrate(doc: Document) {
    const benchmark = doc.get("benchmark", true);
    if (!isMap(benchmark)) return;
    const index = benchmark.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "include_ai_lookups");
    if (index === -1) return;
    // Comments above the first entry belong to the map itself.
    if (index === 0) delete benchmark.commentBefore;
    // YAML attaches the first comment above the key to an empty preceding value. Its own inline comment stays.
    const previous = benchmark.items[index - 1]?.value;
    if (isScalar(previous) && previous.value === null && previous.source === "" && typeof previous.comment === "string") {
      const lines = previous.comment.split("\n");
      const key = benchmark.items[index]?.key;
      const inlineOnly = isScalar(key) && previous.range && key.range && previous.range[2] === key.range[0];
      if (lines.length > 1 || inlineOnly) previous.comment = lines[0];
      else delete previous.comment;
    }
    benchmark.items.splice(index, 1);
  },
};
