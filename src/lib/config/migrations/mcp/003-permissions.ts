import { isAlias, isMap, isNode, isScalar, visit, Scalar } from "yaml";

import { PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";

import { isUnset } from "../../yaml-options";
import type { ConfigMigration } from "../types";

/** Version-2 defaults, shared by whole files and overlays; independent of the current shipped file. */
const oldDefaults = {
  search_jobs: true,
  get_job: true,
  list_applications: true,
  get_application_context: false,
  save_application_answer: false,
} as const;

type OldTool = keyof typeof oldDefaults;

export const mcpPermissions: ConfigMigration = {
  from: 2,
  to: 3,
  wholeFiles: true,
  description: "replace tool switches with data-area permissions for the global matrix and stdio connection",
  migrate(doc) {
    const map = doc.contents;
    if (!isMap(map) || !map.has("tools")) return;
    const rawTools = map.get("tools", true);
    const tools = isAlias(rawTools) ? rawTools.resolve(doc) : rawTools;
    const effective: Record<OldTool, boolean> = { ...oldDefaults };
    if (isMap(tools)) {
      for (const pair of tools.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !Object.hasOwn(oldDefaults, pair.key.value)) return;
        const node = isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
        if (!isScalar(node)) return;
        const value: unknown = node.value;
        if (typeof value !== "boolean" && !isUnset(value)) return;
        const name = pair.key.value as OldTool;
        effective[name] = typeof value === "boolean" ? value : oldDefaults[name];
      }
    } else if (!isScalar(tools) || !isUnset(tools.value)) {
      return;
    }
    const granted = new Set<Permission>();
    if (effective.search_jobs || effective.get_job) granted.add("jobs:read");
    if (effective.list_applications) granted.add("tracking:read");
    if (effective.get_application_context) granted.add("writer:read");
    if (effective.save_application_answer) granted.add("writer:write");
    const permissions = PERMISSIONS.filter((permission) => granted.has(permission));
    const index = map.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "tools");
    const toolsKey = map.items[index]?.key;
    const replacements = [];
    if (!map.has("permissions")) replacements.push(doc.createPair("permissions", permissions));
    if (!map.has("stdio")) {
      replacements.push(doc.createPair("stdio", { permissions }));
    } else {
      const stdio = map.get("stdio", true);
      if (isMap(stdio) && !stdio.has("permissions")) stdio.set("permissions", doc.createNode(permissions));
    }
    const removed = new Set<Scalar>();
    if (isNode(rawTools)) visit(rawTools, { Scalar(_key, node) { removed.add(node); } });
    visit(doc, {
      Alias(_key, node) {
        const target = node.resolve(doc);
        if (!isScalar(target) || !removed.has(target)) return;
        const replacement = new Scalar(target.value);
        replacement.comment = node.comment;
        replacement.commentBefore = node.commentBefore;
        replacement.spaceBefore = node.spaceBefore;
        return replacement;
      },
    });
    const first = replacements[0]?.key;
    if (isScalar(toolsKey) && isScalar(first)) first.spaceBefore = toolsKey.spaceBefore;
    map.items.splice(index, 1, ...replacements);
    if (effective.search_jobs === effective.get_job) return;
    const off = effective.search_jobs ? "get_job" : "search_jobs";
    return [`search_jobs and get_job now share the permission jobs:read: ${off} was off and is offered again; remove jobs:read from permissions to switch both off`];
  },
};
