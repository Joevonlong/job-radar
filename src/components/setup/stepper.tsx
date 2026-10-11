"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import "@/components/viz/viz.css";
import { cn } from "@/lib/utils";
import { SETUP_STEP_IDS, stepIndex, type SetupStepId, type SetupStepStatus } from "@/lib/setup/steps";

import { stepHref } from "./use-step";

type CellState = "done" | "skipped" | "current" | "open";

function cellState(id: SetupStepId, current: SetupStepId, status: SetupStepStatus | null): CellState {
  if (id === current) return "current";
  return status ?? "open";
}

/** One cell of the segmented bar: solid = done, hatched = skipped, amber = current, grid = not reached. */
function Cell({ state, className }: { state: CellState; className?: string }) {
  return (
    <span
      aria-hidden
      data-cell={state}
      className={cn(
        "block h-3 w-full rounded-cell border-[1.5px] border-border transition-colors duration-base motion-reduce:transition-none",
        state === "done" && "bg-ink",
        state === "skipped" && "jr-hatch bg-card text-ink-3",
        state === "current" && "bg-hi shadow-e1",
        state === "open" && "bg-grid",
        className,
      )}
    />
  );
}

interface StepperProps {
  current: SetupStepId;
  steps: Record<SetupStepId, { status: SetupStepStatus | null }>;
}

/**
 * The wizard's step bar: an 8-cell segmented bar, each cell a link to its step. Desktop shows the names under
 * the cells; below `md` it collapses to "3/8 · Profile" above the bar. `nav > ol`, the current step is `aria-current="step"`.
 */
export function Stepper({ current, steps }: StepperProps) {
  const t = useTranslations("setup");
  const total = SETUP_STEP_IDS.length;
  const index = stepIndex(current) + 1;
  return (
    <nav aria-label={t("stepper.label")} data-testid="setup-stepper" className="flex flex-col gap-sp-2">
      <p className="font-mono text-data font-semibold text-ink md:hidden" data-testid="setup-stepper-compact">
        {t("stepper.compact", { current: index, total, name: t(`steps.${current}.name`) })}
      </p>
      <ol className="grid grid-cols-8 gap-1 md:gap-sp-2">
        {SETUP_STEP_IDS.map((id, i) => {
          const state = cellState(id, current, steps[id].status);
          const name = t(`steps.${id}.name`);
          const label = t("stepper.item", { index: i + 1, name, state: t(`stepper.state.${state}`) });
          return (
            <li key={id} className="min-w-0">
              <Link
                href={stepHref(id)}
                aria-current={id === current ? "step" : undefined}
                aria-label={label}
                data-step={id}
                data-state={state}
                className="group flex min-w-0 flex-col gap-1.5 rounded-tag py-1 outline-none focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-signal-t4"
              >
                <Cell state={state} className="group-hover:shadow-e1" />
                <span className={cn("hidden truncate font-mono text-data-sm md:block", id === current ? "font-bold text-ink" : "text-ink-2 group-hover:text-ink")}>
                  {i + 1}. {name}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
