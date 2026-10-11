import { getTranslations } from "next-intl/server";

import { EnabledBadge } from "./enabled-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { SourceCard } from "@/lib/sources/view";

/**
 * Channels that are configured but have no code yet: nothing runs, so nothing to chart or trigger. One compact row each
 * in a section that is closed by default. The rows keep the `channel-card` hooks (badges included) of the full cards.
 */
export async function PendingChannels({ cards }: { cards: readonly SourceCard[] }) {
  if (cards.length === 0) return null;
  const t = await getTranslations("sources");
  return (
    <Card className="gap-0 py-0" data-testid="pending-channels">
      <details>
        <summary className="font-display text-h2 cursor-pointer px-4 py-3">{t("pending.title", { count: cards.length })}</summary>
        <ul className="border-border border-t-bw flex flex-col px-4 py-1">
          {cards.map((card) => (
            <li
              key={card.id}
              className="border-grid flex flex-wrap items-center gap-x-3 gap-y-1 border-t-[1.5px] py-2 first:border-t-0"
              data-testid="channel-card"
              data-compact="1"
              data-channel={card.id}
              data-enabled={card.enabled ? "1" : "0"}
              data-circuit={card.circuit?.state ?? "none"}
              data-status={card.status}
            >
              <span className="font-mono text-title font-extrabold">{card.id}</span>
              <EnabledBadge enabled={card.enabled} data-testid="enabled-badge" data-state={card.enabled ? "ok" : "off"}>
                {card.enabled ? t("card.enabled") : t("card.disabled")}
              </EnabledBadge>
              {card.notConfigured ? (
                <Badge variant="gate-warn" data-testid="not-configured">
                  {t("card.notConfigured")}
                </Badge>
              ) : null}
              {card.login ? (
                <Badge variant={card.login.status === "valid" ? "outline" : card.login.status === "expired" ? "gate-bad" : "gate-warn"} data-testid="login-status" data-status={card.login.status}>
                  {t(`card.login.${card.login.status}`)}
                </Badge>
              ) : null}
              <Badge variant="gate-note">{t("card.notImplemented")}</Badge>
              <span className="text-ink-2 text-data min-w-0 flex-1 basis-60" data-testid="missing-env">
                {card.missingEnv.length > 0 && card.enabled ? t("card.missingEnv", { names: card.missingEnv.join(", ") }) : t("card.notImplementedHint")}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
