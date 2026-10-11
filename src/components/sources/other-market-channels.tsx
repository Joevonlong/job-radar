import { getTranslations } from "next-intl/server";

import { EnabledBadge } from "./enabled-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { SourceCard } from "@/lib/sources/view";

/**
 * Channels that serve only other markets (`markets` of sources.yaml without the home country). They do not run in
 * this market and that is not a failure (C2); one compact row each, in a section that is closed by default.
 */
export async function OtherMarketChannels({ cards }: { cards: readonly SourceCard[] }) {
  if (cards.length === 0) return null;
  const t = await getTranslations("sources");
  return (
    <Card className="gap-0 py-0" data-testid="other-market-channels">
      <details>
        <summary className="font-display text-h2 cursor-pointer px-4 py-3">{t("otherMarket.title", { count: cards.length })}</summary>
        <p className="text-ink-2 text-body-sm border-border border-t-bw px-4 py-2">{t("otherMarket.hint")}</p>
        <ul className="flex flex-col px-4 py-1">
          {cards.map((card) => (
            <li
              key={card.id}
              className="border-grid flex flex-wrap items-center gap-x-3 gap-y-1 border-t-[1.5px] py-2 first:border-t-0"
              data-testid="channel-card"
              data-compact="1"
              data-channel={card.id}
              data-enabled="0"
              data-status={card.status}
              data-other-market="1"
            >
              <span className="font-mono text-title font-extrabold">{card.id}</span>
              <EnabledBadge enabled={false} data-testid="enabled-badge" data-state="off">
                {t("card.disabled")}
              </EnabledBadge>
              <Badge variant="gate-note" data-testid="other-market">
                {t("otherMarket.badge", { markets: card.markets.join(", ") })}
              </Badge>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
