"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";

import { addQuestionAction, deleteQuestionAction, updateQuestionAction, type WriterActionResult } from "@/app/jobs/[id]/apply/actions";
import { Panel, PanelAside } from "@/components/jobs/detail/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/actions/client";
import { LENGTH_UNITS, QUESTION_KINDS, type LengthUnit, type QuestionKind } from "@/lib/config/schemas/writer";
import { languageAutonym } from "@/lib/i18n/languages";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

interface Settings {
  text: string;
  kind: QuestionKind;
  lengthUnit: LengthUnit;
  lengthValue: number;
  outputLanguage: string;
  tone: string;
}

/** The shipped tones that have a label; a tone added in writer.yaml shows its id. */
const SHIPPED_TONES = ["neutral", "warm", "confident", "formal"] as const;

const failed = (): WriterActionResult => ({ ok: false, error: "failed" });

/** The job's questions (pick one to work on), a form to add one, and the settings of the picked one. */
export function QuestionsPanel({ view, activeId, onSelect, enabled }: { view: WorkbenchView; activeId: number | null; onSelect: (id: number) => void; enabled: boolean }) {
  const t = useTranslations("writer.questions");
  const tw = useTranslations("writer");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<QuestionKind>("question");
  const full = view.questions.length >= view.limits.maxQuestions;
  const active = view.questions.find((question) => question.id === activeId) ?? null;
  const textId = useId();

  const report = (result: WriterActionResult, success?: string): boolean => {
    if (!result.ok) {
      toastTone("error", tw(`actionError.${result.error}`));
      return false;
    }
    if (success) toastTone("success", success);
    router.refresh();
    return true;
  };

  const add = (): void => {
    const defaults = view.kinds[kind];
    startTransition(async () => {
      const result = await callAction(
        () => addQuestionAction({ jobId: view.job.id, settings: { text: text.trim() === "" && kind === "letter" ? t("letterText") : text, kind, lengthUnit: defaults.unit, lengthValue: defaults.value, outputLanguage: view.defaultLanguage, tone: view.tones[0] ?? "neutral" } }),
        failed,
      );
      if (report(result)) {
        setText("");
        if ("questionId" in result && result.questionId !== undefined) onSelect(result.questionId);
      }
    });
  };

  return (
    <Panel id="writer-questions" title={t("title")} aside={<PanelAside>{t("count", { count: view.questions.length, max: view.limits.maxQuestions })}</PanelAside>}>
      <div className="flex flex-col gap-4">
        {view.questions.length === 0 ? <p className="text-ink-2 text-body-sm" data-testid="writer-no-questions">{t("empty")}</p> : null}
        <ul className="flex flex-col gap-1.5" data-testid="writer-question-list">
          {view.questions.map((question, index) => (
            <li key={question.id}>
              <button
                type="button"
                onClick={() => onSelect(question.id)}
                aria-current={question.id === activeId ? "true" : undefined}
                className={cn(
                  "rounded-card border-bw border-border hover:bg-soft focus-visible:ring-ring flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none",
                  question.id === activeId ? "bg-soft shadow-e2" : "bg-card",
                )}
                data-testid="writer-question"
                data-question-id={question.id}
              >
                <span className="text-body-sm line-clamp-2 font-semibold [overflow-wrap:anywhere]">
                  {index + 1}. {question.text}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="status">{t(`kind.${question.kind}`)}</Badge>
                  <Badge variant="status">{t("versions", { count: question.versions.length })}</Badge>
                  {question.finalVersionId !== null ? <Badge variant="status-good" data-testid="writer-question-final">{t("final")}</Badge> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="border-grid flex flex-col gap-2 border-t-[1.5px] pt-3" data-testid="writer-add-question">
          <label htmlFor={textId} className="text-body-sm font-semibold">
            {t("addLabel")}
          </label>
          <Textarea id={textId} value={text} onChange={(event) => setText(event.target.value)} maxLength={view.limits.textMaxChars} rows={3} placeholder={t("addPlaceholder")} disabled={!enabled || full} data-testid="writer-add-text" />
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label={t("kindLabel")} value={kind} onChange={(event) => setKind(event.target.value as QuestionKind)} disabled={!enabled || full} size="sm" data-testid="writer-add-kind">
              {QUESTION_KINDS.map((name) => (
                <option key={name} value={name}>
                  {t(`kind.${name}`)}
                </option>
              ))}
            </NativeSelect>
            <Button type="button" size="sm" onClick={add} disabled={!enabled || full || pending || (text.trim() === "" && kind === "question")} data-testid="writer-add-button">
              <Plus aria-hidden /> {t("add")}
            </Button>
          </div>
          {full ? <p className="text-ink-3 text-body-sm">{t("full", { max: view.limits.maxQuestions })}</p> : null}
        </div>

        {active ? <QuestionSettings key={active.id} view={view} question={active} enabled={enabled} report={report} /> : null}
      </div>
    </Panel>
  );
}

function QuestionSettings({ view, question, enabled, report }: { view: WorkbenchView; question: WorkbenchQuestion; enabled: boolean; report: (result: WriterActionResult, success?: string) => boolean }) {
  const t = useTranslations("writer.questions");
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settings, setSettings] = useState<Settings>({ text: question.text, kind: question.kind, lengthUnit: question.lengthUnit, lengthValue: question.lengthValue, outputLanguage: question.outputLanguage, tone: question.tone });
  const dirty = (Object.keys(settings) as (keyof Settings)[]).some((key) => settings[key] !== question[key]);
  const ids = { text: useId(), length: useId() };
  const toneLabel = (tone: string): string => {
    const known = SHIPPED_TONES.find((entry) => entry === tone);
    return known ? t(`tone.${known}`) : tone;
  };
  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void => setSettings((current) => ({ ...current, [key]: value }));

  const save = (): void => {
    startTransition(async () => {
      report(await callAction(() => updateQuestionAction({ jobId: view.job.id, questionId: question.id, settings }), failed), t("saved"));
    });
  };
  const remove = (): void => {
    startTransition(async () => {
      report(await callAction(() => deleteQuestionAction({ jobId: view.job.id, questionId: question.id }), failed), t("deleted"));
    });
  };

  return (
    <div className="border-grid flex flex-col gap-2.5 border-t-[1.5px] pt-3" data-testid="writer-question-settings">
      <h3 className="text-body font-semibold">{t("settingsTitle")}</h3>
      <label htmlFor={ids.text} className="text-ink-2 text-body-sm">
        {t("textLabel")}
      </label>
      <Textarea id={ids.text} value={settings.text} onChange={(event) => set("text", event.target.value)} maxLength={view.limits.textMaxChars} rows={3} disabled={!enabled} data-testid="writer-question-text" />
      <div className="grid grid-cols-2 gap-2">
        <NativeSelect aria-label={t("kindLabel")} value={settings.kind} onChange={(event) => set("kind", event.target.value as QuestionKind)} disabled={!enabled} size="sm">
          {QUESTION_KINDS.map((name) => (
            <option key={name} value={name}>
              {t(`kind.${name}`)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label={t("toneLabel")} value={settings.tone} onChange={(event) => set("tone", event.target.value)} disabled={!enabled} size="sm" data-testid="writer-question-tone">
          {view.tones.map((tone) => (
            <option key={tone} value={tone}>
              {toneLabel(tone)}
            </option>
          ))}
        </NativeSelect>
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor={ids.length} className="sr-only">
            {t("lengthLabel")}
          </label>
          <Input id={ids.length} type="number" inputMode="numeric" min={10} max={5000} value={settings.lengthValue} onChange={(event) => set("lengthValue", Math.max(10, Math.min(5000, Number(event.target.value) || 10)))} disabled={!enabled} className="w-20" data-testid="writer-question-length" />
          <NativeSelect aria-label={t("unitLabel")} value={settings.lengthUnit} onChange={(event) => set("lengthUnit", event.target.value as LengthUnit)} disabled={!enabled} size="sm">
            {LENGTH_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(`unit.${unit}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <NativeSelect aria-label={t("languageLabel")} value={settings.outputLanguage} onChange={(event) => set("outputLanguage", event.target.value)} disabled={!enabled} size="sm" data-testid="writer-question-language">
          {view.languages.map((code) => (
            <option key={code} value={code}>
              {languageAutonym(code)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={!enabled || !dirty || pending || settings.text.trim() === ""} data-testid="writer-question-save">
          {t("save")}
        </Button>
        {confirmDelete ? (
          <Button type="button" size="sm" variant="danger" onClick={remove} disabled={pending} data-testid="writer-question-delete-confirm">
            <Trash2 aria-hidden /> {t("deleteConfirm")}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(true)} disabled={pending} data-testid="writer-question-delete">
            <Trash2 aria-hidden /> {t("delete")}
          </Button>
        )}
      </div>
    </div>
  );
}
