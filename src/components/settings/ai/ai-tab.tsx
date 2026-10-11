import { AiBlock } from "./block";
import { DisclosureSection } from "./disclosure-section";
import type { AiTabContext } from "./context";
import { LimitsSection } from "./limits-section";
import { ProviderVendors } from "./provider-vendors";
import { RoutingSection } from "./routing-section";
import { ScoringSection } from "./scoring-section";

/**
 * The AI tab body: four numbered blocks, each with its own frame. 1 vendors (how each is reached, which models),
 * 2 routing (global order and per-task assignment), 3 limits and budget, 4 scoring parameters. The draft and the YAML are unchanged.
 */
export function AiTab({ ctx }: { ctx: AiTabContext }) {
  const { t } = ctx;
  return (
    <div className="flex flex-col gap-5" data-testid="ai-tab">
      <AiBlock n={1} id="providers" title={t("ai.block.providers.title")} hint={t("ai.block.providers.hint")}>
        <ProviderVendors ctx={ctx} />
      </AiBlock>
      <AiBlock n={2} id="routing" title={t("ai.block.routing.title")} hint={t("ai.block.routing.hint")}>
        <RoutingSection ctx={ctx} />
        <DisclosureSection ctx={ctx} />
      </AiBlock>
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <AiBlock n={3} id="limits" title={t("ai.block.limits.title")} hint={t("ai.block.limits.hint")}>
          <LimitsSection ctx={ctx} />
        </AiBlock>
        <AiBlock n={4} id="scoring" title={t("ai.block.scoring.title")} hint={t("ai.block.scoring.hint")}>
          <ScoringSection ctx={ctx} />
        </AiBlock>
      </div>
    </div>
  );
}
