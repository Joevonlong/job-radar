import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AI_TASK_NAMES, type AiProviderIdChoice } from "@/lib/config/ai-options";
import { isProviderNode } from "@/lib/settings/ai-vendors";
import type { RouteDraft } from "@/lib/settings/draft";
import type { FieldDef } from "@/lib/settings/fields";

import { FieldCell, nodeLabels } from "../field-control";
import { SubHeading } from "./block";
import { aiSection, type AiTabContext } from "./context";

interface ChainNode {
  provider: string;
  /** Model chosen for this node; "" = the provider's default (not shown). */
  model: string;
}

const isRouteRow = (value: unknown): value is RouteDraft => typeof value === "object" && value !== null && "provider" in value;

/** The chain as chips "OpenAI · Subscription → Anthropic · API"; a node's own model is small text after it, only when it is set. */
function Chain({ nodes, labels, modelName }: { nodes: ChainNode[]; labels: Record<string, string>; modelName: (provider: string, model: string) => string }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" data-testid="chain">
      {nodes.map((node, index) => (
        <li key={node.provider} className="flex items-center gap-1.5">
          {index > 0 ? <ArrowRight aria-hidden className="text-ink-3 size-3.5" /> : null}
          <Badge variant="skill" data-provider={node.provider}>
            {labels[node.provider] ?? node.provider}
            {node.model !== "" ? <span className="text-ink-2 font-sans font-medium">· {modelName(node.provider, node.model)}</span> : null}
          </Badge>
        </li>
      ))}
    </ol>
  );
}

/**
 * Block 2: the global chain (and the order inside the API layer), then one line per AI task. Read mode is a compact line: name, the chain
 * as chips (a node's model only when it differs from the provider default), a "follow global" tag when inheriting, and an Edit button.
 * Edit opens that line's editor in place; one editor is open at a time.
 */
export function RoutingSection({ ctx }: { ctx: AiTabContext }) {
  const { t, draft } = ctx;
  const [editing, setEditing] = useState<string | null>(null);
  const order = aiSection("order");
  const tasks = aiSection("tasks");
  const catalog = ctx.catalog?.catalog ?? null;
  const modelName = (provider: string, model: string): string => {
    if (!isProviderNode(provider)) return model;
    const found = catalog?.providers[provider as AiProviderIdChoice].models.find((m) => m.id === model);
    return found?.label ?? model;
  };

  const line = (def: FieldDef, name: string, nodes: ChainNode[], inherit: boolean, testId: string) => {
    const open = editing === def.path;
    const labels = nodeLabels(t, [...nodes.map((n) => n.provider), ...(def.options ?? [])]);
    return (
      <div key={def.path} data-testid={testId} data-custom={inherit ? "0" : "1"} data-editing={open ? "1" : "0"} className="flex flex-col gap-3 px-3 py-2.5">
        <div className="grid items-center gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr_auto]">
          <span className="text-label font-bold">{name}</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {inherit ? (
              <Badge variant="skill-miss" data-testid={`${testId}-inherit`}>
                {t("controls.inherit")}
              </Badge>
            ) : (
              <Chain nodes={nodes} labels={labels} modelName={modelName} />
            )}
            {ctx.dirty.has(def.path) ? (
              <Badge variant="outline" className="text-on-signal bg-warn border-border">
                {t("controls.changed")}
              </Badge>
            ) : null}
          </div>
          <Button type="button" variant="outline" size="xs" aria-expanded={open} data-testid={`${testId}-edit`} onClick={() => setEditing(open ? null : def.path)}>
            {open ? t("ai.done") : t("ai.edit")}
          </Button>
        </div>
        {open ? (
          <div className="flex flex-col gap-2" data-testid={`${testId}-editor`}>
            <FieldCell def={def} base={ctx.base} draft={draft} dirty={ctx.dirty} errors={ctx.errors} patch={ctx.patch} t={t} providerStates={ctx.providerStates} catalog={ctx.catalog} compact />
            {def.kind === "route" && !inherit ? (
              <Button type="button" variant="ghost" size="xs" className="w-fit" onClick={() => ctx.patch(def.path, [])} data-testid={`${testId}-reset`}>
                {t("ai.followGlobal")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const frame = "border-border bg-card rounded-tag border-bw divide-grid divide-y-[1.5px]";
  return (
    <>
      <section className="flex flex-col gap-3" data-testid="section-order">
        <SubHeading hint={t("sectionHints.ai_order")}>{t("sections.ai_order")}</SubHeading>
        <div className={frame}>
          {order.fields.map((def) => {
            const values = draft[def.path];
            const nodes = (Array.isArray(values) ? values : []).filter((v): v is string => typeof v === "string").map((provider) => ({ provider, model: "" }));
            return line(def, t(`fields.${def.label}.label`), nodes, false, `order-row-${def.path}`);
          })}
        </div>
      </section>
      <section className="flex flex-col gap-3" data-testid="section-tasks">
        <SubHeading hint={t("sectionHints.ai_tasks")}>{t("sections.ai_tasks")}</SubHeading>
        <div role="group" aria-label={t("sections.ai_tasks")} className={frame}>
          <div className="text-cap-style text-ink-2 bg-soft rounded-t-tag hidden gap-4 px-3 py-1.5 sm:grid sm:grid-cols-[9rem_1fr]" aria-hidden>
            <span>{t("ai.taskCol")}</span>
            <span>{t("ai.taskRouteCol")}</span>
          </div>
          {tasks.fields.map((def, index) => {
            const task = AI_TASK_NAMES[index];
            const rows = draft[def.path];
            const nodes = (Array.isArray(rows) ? rows : []).filter(isRouteRow).map((r) => ({ provider: r.provider, model: r.model }));
            return line(def, t(`fields.${def.label}.label`), nodes, nodes.length === 0, `task-row-${task}`);
          })}
        </div>
      </section>
    </>
  );
}
