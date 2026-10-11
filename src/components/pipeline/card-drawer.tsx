"use client";

import { Clock, ExternalLink, Minus, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";

import { saveApplicationNotesAction } from "@/app/jobs/[id]/actions";
import { saveNextActionAction, setInterviewRoundsAction } from "@/app/pipeline/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TermLog } from "@/components/viz";
import { isEndedStatus } from "@/lib/dashboard/board";
import { INTERVIEW_ROUNDS_MAX, NEXT_ACTION_MAX_CHARS, NOTES_MAX_CHARS } from "@/lib/dashboard/limits";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { ALL_APPLICATION_STATUSES, statusChoices } from "@/lib/applications/visibility";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { CompanyMark } from "./company-mark";
import { SalaryChip } from "./salary-chip";
import { timelineLines } from "./timeline-lines";
import { COLUMN_COLOR } from "./status-colors";
import type { BoardCard } from "./types";

interface CardDrawerProps {
  /** The card shown; null = closed. */
  card: BoardCard | null;
  onClose: () => void;
  onMove: (jobId: number, status: ApplicationStatus) => void;
  /** The element that gets the focus when the drawer closes (the title button of the card that opened it). */
  returnFocus?: () => HTMLElement | null;
}

const sectionTitle = "text-muted-foreground text-xs font-medium";

/**
 * Detail drawer of a pipeline card (shadcn Sheet): status, next step, interview rounds, notes and
 * the full timeline of status changes, with a link to the job detail page.
 */
export function CardDrawer({ card, onClose, onMove, returnFocus }: CardDrawerProps) {
  const t = useTranslations("pipeline");
  const ts = useTranslations("dashboard.status");
  const hidden = useHiddenStatuses();

  return (
    <Sheet open={card !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
        data-testid="card-drawer"
        onCloseAutoFocus={(event) => {
          // the drawer was opened from a card, not from a trigger: Radix would drop the focus on the page body
          const target = returnFocus?.();
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {card ? (
          <>
            <SheetHeader className="pr-10">
              <div className="flex items-center gap-sp-2">
                <CompanyMark name={card.job.companyName} className="size-ctl-sm" />
                <div className="min-w-0">
                  <SheetTitle className="[overflow-wrap:anywhere]">{card.job.companyName}</SheetTitle>
                  <SheetDescription className="[overflow-wrap:anywhere]">{card.job.title}</SheetDescription>
                </div>
              </div>
              <Link href={`/jobs/${card.jobId}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-1 self-start")} data-testid="drawer-open-job">
                <ExternalLink aria-hidden />
                {t("drawer.openJob")}
              </Link>
            </SheetHeader>

            <div className="flex flex-col gap-5 px-4 pb-6">
              <SalaryChip salary={card.salary} floor={card.job.amountMinAnnualEur} className="self-start" />
              <StepBar status={card.status} />
              <section className="flex flex-col gap-1.5">
                <label htmlFor="drawer-status" className={sectionTitle}>
                  {t("drawer.status")}
                </label>
                <NativeSelect
                  id="drawer-status"
                  value={card.status}
                  data-testid="drawer-status"
                  onChange={(event) => {
                    const next = ALL_APPLICATION_STATUSES.find((s) => s === event.target.value);
                    if (next) onMove(card.jobId, next);
                  }}
                >
                  {statusChoices(card.status, hidden).map(({ status: s, hidden: isHidden }) => (
                    <option key={s} value={s}>
                      {isHidden ? t("card.hiddenStatus", { status: ts(s) }) : ts(s)}
                    </option>
                  ))}
                </NativeSelect>
                {card.overdue ? (
                  <span className="bg-warning/15 text-foreground inline-flex items-center gap-1 self-start rounded-sm px-[7px] py-0.5 text-xs font-medium" data-testid="drawer-overdue">
                    <Clock aria-hidden className="text-warning-text size-3.5" />
                    {t(`overdue.${card.overdue.kind}`, { days: card.overdue.days })}
                  </span>
                ) : null}
              </section>

              <NextActionForm key={`next-${card.jobId}`} card={card} />
              <RoundsStepper key={`rounds-${card.jobId}`} card={card} />
              <NotesForm key={`notes-${card.jobId}`} card={card} />
              <Timeline card={card} />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function NextActionForm({ card }: { card: BoardCard }) {
  const t = useTranslations("pipeline.drawer");
  const te = useTranslations("pipeline.error");
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(card.nextAction ?? "");
  const [date, setDate] = useState(card.nextActionDate ?? "");

  // follow what the server says after a save: adjust state while rendering when a prop changed
  const [seen, setSeen] = useState({ text: card.nextAction ?? "", date: card.nextActionDate ?? "" });
  if (seen.text !== (card.nextAction ?? "") || seen.date !== (card.nextActionDate ?? "")) {
    setSeen({ text: card.nextAction ?? "", date: card.nextActionDate ?? "" });
    setText(card.nextAction ?? "");
    setDate(card.nextActionDate ?? "");
  }
  const dirty = text !== seen.text || date !== seen.date;

  return (
    <form
      className="flex flex-col gap-1.5"
      data-testid="next-action-form"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await saveNextActionAction({ jobId: card.jobId, nextAction: text, nextActionDate: date === "" ? null : date });
          if (result.ok) toastTone("success", t("nextActionSaved"));
          else toastTone("error", te(result.error));
        });
      }}
    >
      <label htmlFor="drawer-next-action" className={sectionTitle}>
        {t("nextAction")}
      </label>
      <Input id="drawer-next-action" value={text} maxLength={NEXT_ACTION_MAX_CHARS} placeholder={t("nextActionPlaceholder")} onChange={(event) => setText(event.target.value)} data-testid="next-action-input" />
      <label htmlFor="drawer-next-date" className={cn(sectionTitle, "mt-1")}>
        {t("nextActionDate")}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Input id="drawer-next-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} className="w-auto" data-testid="next-date-input" />
        <Button type="submit" size="sm" disabled={pending || !dirty} data-testid="next-action-save">
          {pending ? t("saving") : t("saveNextAction")}
        </Button>
      </div>
    </form>
  );
}

function RoundsStepper({ card }: { card: BoardCard }) {
  const t = useTranslations("pipeline.drawer");
  const te = useTranslations("pipeline.error");
  const [, startTransition] = useTransition();
  const [rounds, setRounds] = useOptimistic(card.interviewRounds);

  const change = (delta: number) => {
    const next = Math.min(Math.max(rounds + delta, 0), INTERVIEW_ROUNDS_MAX);
    if (next === rounds) return;
    startTransition(async () => {
      setRounds(next);
      const result = await setInterviewRoundsAction({ jobId: card.jobId, rounds: next });
      if (!result.ok) toastTone("error", te(result.error));
    });
  };

  return (
    <section className="flex flex-col gap-1.5" data-testid="rounds-section">
      <span className={sectionTitle} id="drawer-rounds-label">
        {t("rounds")}
      </span>
      <div className="flex items-center gap-2" role="group" aria-labelledby="drawer-rounds-label">
        <Button type="button" variant="outline" size="icon-sm" aria-label={t("roundsRemove")} disabled={rounds <= 0} onClick={() => change(-1)} data-testid="rounds-minus">
          <Minus aria-hidden />
        </Button>
        <span className="min-w-8 text-center font-mono text-base tabular-nums" role="status" data-testid="rounds-value">
          {rounds}
        </span>
        <RoundPips rounds={rounds} />
        <Button type="button" variant="outline" size="icon-sm" aria-label={t("roundsAdd")} disabled={rounds >= INTERVIEW_ROUNDS_MAX} onClick={() => change(1)} data-testid="rounds-plus">
          <Plus aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function NotesForm({ card }: { card: BoardCard }) {
  const t = useTranslations("pipeline.drawer");
  const te = useTranslations("pipeline.error");
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(card.notes);
  const [seen, setSeen] = useState(card.notes);
  if (seen !== card.notes) {
    setSeen(card.notes);
    setValue(card.notes);
  }
  const dirty = value !== seen;

  return (
    <form
      className="flex flex-col gap-1.5"
      data-testid="notes-form"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await saveApplicationNotesAction({ jobId: card.jobId, notes: value });
          if (result.ok) toastTone("success", t("notesSaved"));
          else toastTone("error", te(result.error));
        });
      }}
    >
      <label htmlFor="drawer-notes" className={sectionTitle}>
        {t("notes")}
      </label>
      <textarea
        id="drawer-notes"
        value={value}
        maxLength={NOTES_MAX_CHARS}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t("notesPlaceholder")}
        data-testid="drawer-notes-input"
        className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring min-h-24 w-full resize-y rounded-md border px-2.5 py-1.5 text-sm leading-normal shadow-xs"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || !dirty} data-testid="drawer-notes-save">
          {pending ? t("saving") : t("saveNotes")}
        </Button>
        {dirty ? <span className="text-muted-foreground text-xs">{t("unsaved")}</span> : null}
      </div>
    </form>
  );
}

/** The flow a card walks (design "流程步骤条"); an ended card has walked none of it and says so below. */
const FLOW = ["interested", "preparing", "applied", "interviewing", "offer"] as const satisfies readonly ApplicationStatus[];

function StepBar({ status }: { status: ApplicationStatus }) {
  const t = useTranslations("pipeline.drawer");
  const ts = useTranslations("dashboard.status");
  const ended = isEndedStatus(status);
  const index = FLOW.findIndex((step) => step === status);
  return (
    <section className="flex flex-col gap-1.5" data-testid="drawer-steps">
      <span className={sectionTitle} id="drawer-steps-label">
        {t("stepsLabel")}
      </span>
      <ol aria-labelledby="drawer-steps-label" className="grid grid-cols-5 gap-1">
        {FLOW.map((step, position) => {
          const reached = !ended && index >= position;
          const current = !ended && index === position;
          return (
            <li key={step} aria-current={current ? "step" : undefined} data-reached={reached ? "true" : "false"} className="flex min-w-0 flex-col gap-1">
              <i className={cn("border-ink rounded-cell block h-2 border-2", reached ? COLUMN_COLOR[step].dot : "bg-card-bg", ended && "border-dashed")} />
              <span className={cn("text-data-sm font-mono [overflow-wrap:anywhere]", current ? "text-ink font-bold" : "text-ink-3")}>{ts(step)}</span>
            </li>
          );
        })}
      </ol>
      {ended ? <span className="text-body-sm text-ink-2">{t("stepEnded", { status: ts(status) })}</span> : null}
    </section>
  );
}

/** One cell per round done, up to a handful; the number next to it carries the exact value. */
const PIPS_SHOWN = 8;

function RoundPips({ rounds }: { rounds: number }) {
  const t = useTranslations("pipeline.drawer");
  return (
    <span className="flex items-center gap-0.5" role="img" aria-label={t("roundsValue", { count: rounds })}>
      {Array.from({ length: PIPS_SHOWN }, (_, index) => (
        <i key={index} className={cn("border-ink rounded-cell block h-4 w-3 border-2", index < rounds ? "bg-meter" : "bg-card-bg")} />
      ))}
      {rounds > PIPS_SHOWN ? <span className="text-data-sm font-mono">+</span> : null}
    </span>
  );
}

function Timeline({ card }: { card: BoardCard }) {
  const t = useTranslations("pipeline.drawer");
  const te = useTranslations("pipeline.event");
  const ts = useTranslations("dashboard.status");
  const lines = timelineLines(card.events, {
    status: (status) => ts(status),
    created: (to) => te("created", { to }),
    moved: (from, to) => te("moved", { from, to }),
    stayed: (to) => te("stayed", { to }),
    note: (text) => te("note", { text }),
    generic: (kind) => te("generic", { kind }),
  });
  return (
    <section className="border-border flex flex-col gap-2 border-t pt-4" data-testid="timeline">
      <h3 className={sectionTitle}>{t("timeline")}</h3>
      {lines.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{t("timelineEmpty")}</p>
      ) : (
        // the log types its lines out when it scrolls into view; inside the scrolling drawer it may stay below the fold, so the text is always shown
        <TermLog lines={lines} className="[&_.jr-term\_\_txt]:w-auto!" />
      )}
    </section>
  );
}
