import { getTranslations } from "next-intl/server";

import { problemSteps, type CycleStepStatus } from "@/lib/cycle/step-health";

/**
 * The steps of the latest cycle that did not do their job, in plain words: which one, what it means for the numbers, what to do.
 * Never a dev-doc path; the step's own technical error text sits under "technical details".
 */
export async function CycleStepIssues({ steps, unprocessed, fetched }: { steps: readonly CycleStepStatus[]; unprocessed: number; fetched: number }) {
  const { failed, partial } = problemSteps(steps);
  if (failed.length === 0 && partial.length === 0) return null;
  const [t, tCycle] = await Promise.all([getTranslations("sources.cycle"), getTranslations("dashboard.cycle")]);
  const errorOf = (name: string) => steps.find((step) => step.name === name)?.error ?? null;
  const waiting = unprocessed > 0 && failed.some((name) => name === "pipeline" || name === "filter");

  return (
    <div className="flex flex-col gap-1.5 text-body-sm" data-testid="cycle-step-issues" role="status">
      {waiting ? <p className="text-ink font-semibold">{tCycle("unprocessed", { fetched: Math.max(fetched, unprocessed), count: unprocessed })}</p> : null}
      <ul className="flex flex-col gap-1.5">
        {failed.map((name) => (
          <li key={name} data-step={name} data-status="failed">
            <b className="text-bad font-extrabold">{tCycle(`step.${name}`)}</b>
            <span className="text-ink-2"> · {t("stepFailed")}</span> <span>{tCycle(`stepHelp.${name}`)}</span>
            {errorOf(name) ? (
              <details className="text-ink-2 mt-0.5 font-mono text-data">
                <summary className="cursor-pointer">{t("technical")}</summary>
                <span className="break-words">{errorOf(name)}</span>
              </details>
            ) : null}
          </li>
        ))}
        {partial.map((name) => (
          <li key={name} data-step={name} data-status="partial">
            <b className="text-warning-text font-extrabold">{tCycle(`step.${name}`)}</b>
            <span className="text-ink-2"> · {t("stepPartial")}</span> <span>{tCycle(`stepHelpPartial.${name}`)}</span>
          </li>
        ))}
      </ul>
      <p className="text-ink-2">{t("nextCycle")}</p>
    </div>
  );
}
