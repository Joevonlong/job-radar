import { DocLink } from "@/components/ui/doc-link";
import { Badge } from "@/components/ui/badge";

import { nodeLabels } from "../field-control";
import { SubHeading } from "./block";
import type { AiTabContext } from "./context";

/**
 * Read-only: per AI task the providers that may receive job text, in the order they are tried. It comes from the saved ai.yaml (the
 * effective order of each task), not from the unsaved form, so it says what is true now; the editors above change it after a save.
 */
export function DisclosureSection({ ctx }: { ctx: Pick<AiTabContext, "t" | "aiDisclosure"> }) {
  const { t, aiDisclosure } = ctx;
  if (aiDisclosure === null || aiDisclosure === undefined) return null;
  const labels = nodeLabels(t, aiDisclosure.flatMap((row) => row.providers));
  return (
    <section className="flex flex-col gap-3" data-testid="section-disclosure">
      <SubHeading hint={t.rich("ai.disclosure.hint", { docs: (chunks) => <DocLink doc="aiProviders">{chunks}</DocLink> })}>{t("ai.disclosure.title")}</SubHeading>
      <ul className="border-border bg-card rounded-tag border-bw divide-grid divide-y-[1.5px]">
        {aiDisclosure.map((row) => (
          <li key={row.task} className="grid items-center gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[9rem_1fr]" data-testid={`disclosure-row-${row.task}`}>
            <span className="text-label font-bold">{t(`fields.task_${row.task}.label`)}</span>
            {row.providers.length === 0 ? (
              <span className="text-body-sm text-ink-2" data-testid={`disclosure-none-${row.task}`}>
                {t("ai.disclosure.none")}
              </span>
            ) : (
              <ol className="flex flex-wrap items-center gap-1.5">
                {row.providers.map((provider, index) => (
                  <li key={provider} className="flex items-center gap-1.5">
                    <span aria-hidden className="text-cap text-ink-3 font-mono tabular-nums">
                      {index + 1}
                    </span>
                    <Badge variant="skill" data-provider={provider}>
                      {labels[provider] ?? provider}
                    </Badge>
                  </li>
                ))}
                {row.web ? (
                  <li className="text-cap text-ink-2">{t("ai.disclosure.web")}</li>
                ) : null}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
