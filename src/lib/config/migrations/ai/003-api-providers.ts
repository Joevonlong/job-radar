import { isScalar } from "yaml";

import { seqAt } from "../edit";
import type { ConfigMigration } from "../types";

const ADDED = ["openai", "openrouter"] as const;

/**
 * ai.yaml 2 -> 3: the OpenAI and OpenRouter API providers. Their `providers` blocks come from the schema defaults; this
 * step only appends the missing ids to the end of `api_order`, so the user's own order stays as it was. Without a key in
 * .env such a provider is skipped and sends nothing.
 */
export const ai003: ConfigMigration = {
  from: 2,
  to: 3,
  description: "new API providers openai and openrouter: appended to the end of api_order (skipped until their key is in .env)",
  migrate(doc) {
    const order = seqAt(doc, ["api_order"]);
    // a missing or malformed api_order is reported by the schema
    if (order === null) return;
    const present = new Set(order.items.map((item) => (isScalar(item) ? item.value : item)));
    for (const id of ADDED) if (!present.has(id)) order.items.push(doc.createNode(id));
  },
};
