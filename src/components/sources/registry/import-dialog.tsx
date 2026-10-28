"use client";

import { FileUp, Loader2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, useTransition } from "react";

import { applySourcesImportAction as rawApplySourcesImportAction, previewSourcesImportAction as rawPreviewSourcesImportAction } from "@/app/sources/registry/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DocLink } from "@/components/ui/doc-link";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ImportChange, ImportFormat, ImportIssue, ImportMode } from "@/lib/sources/registry/import";
import type { ImportPreviewState } from "@/lib/sources/registry/service";
import { toastTone } from "@/lib/toast";
import { withActionFeedback } from "@/lib/actions/client";

const applySourcesImportAction = withActionFeedback(rawApplySourcesImportAction)(() => ({ status: "error", error: "write_failed" }));
const previewSourcesImportAction = withActionFeedback(rawPreviewSourcesImportAction)(() => ({ status: "error", error: "write_failed", issues: [] }));

type Preview = Extract<ImportPreviewState, { status: "preview" }>;

/** `json` when the file name or the first character says so, else `yaml`. */
export function detectFormat(fileName: string | null, text: string): ImportFormat {
  if (fileName !== null && /\.json$/i.test(fileName)) return "json";
  if (fileName !== null && /\.ya?ml$/i.test(fileName)) return "yaml";
  const first = text.trimStart()[0];
  return first === "{" || first === "[" ? "json" : "yaml";
}

/** The last field of an issue path (`ats_boards[14].token` -> `token`); empty for a list entry or the document. */
function fieldOf(path: string): string {
  return /\.(\w+)$/.exec(path)?.[1] ?? "";
}

function ChangeLine({ change }: { change: ImportChange }) {
  const t = useTranslations("sourcesRegistry.import.change");
  const label =
    change.kind === "enabled" || change.kind === "disabled" || change.kind === "added" || change.kind === "removed"
      ? t(change.kind)
      : change.kind === "changed" || change.kind === "param"
        ? (change.path ?? "")
        : "";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 border-t-[1.5px] border-grid py-1 font-mono text-data first:border-t-0" data-testid="import-change" data-kind={change.kind} data-group={change.group}>
      <span className="font-bold [overflow-wrap:anywhere]">{change.target}</span>
      {label && !(change.group === "other") ? <span className="text-ink-2">{label}</span> : null}
      {change.from !== undefined || change.to !== undefined ? (
        <span className="[overflow-wrap:anywhere]">
          {change.from !== undefined ? <span className="text-ink-2">{change.from}</span> : null}
          {change.from !== undefined && change.to !== undefined ? " → " : null}
          {change.to !== undefined ? <span>{change.to}</span> : null}
        </span>
      ) : change.group === "other" ? (
        <span className="text-ink-2">{t("listChanged")}</span>
      ) : null}
    </li>
  );
}

/** Import a file or pasted text: validate -> preview of every change -> apply. The server checks everything again on apply. */
export function ImportDialog({ importMaxBytes }: { importMaxBytes: number }) {
  const t = useTranslations("sourcesRegistry.import");
  const tConsent = useTranslations("sourcesRegistry.consent");
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("replace");
  const [state, setState] = useState<ImportPreviewState | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setText("");
    setFileName(null);
    setState(null);
    setApplyError(null);
    setLocalError(null);
    setAcknowledged(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const readFile = async (file: File | undefined) => {
    setState(null);
    setApplyError(null);
    if (!file) return;
    if (file.size > importMaxBytes) {
      setLocalError(t("tooLarge", { limit: Math.round(importMaxBytes / 1024) }));
      setText("");
      setFileName(null);
      return;
    }
    setLocalError(null);
    setFileName(file.name);
    setText(await file.text());
  };

  const preview = () => {
    setApplyError(null);
    setAcknowledged(false);
    startTransition(async () => {
      setState(await previewSourcesImportAction({ text, format: detectFormat(fileName, text), mode }));
    });
  };

  const apply = (current: Preview) => {
    setApplyError(null);
    startTransition(async () => {
      const result = await applySourcesImportAction({ text, format: detectFormat(fileName, text), mode, baseHash: current.baseHash, ...(acknowledged ? { acknowledged: true } : {}) });
      if (result.status === "done") {
        toastTone("success", t("applied"));
        setOpen(false);
        reset();
        return;
      }
      setApplyError(result.error === "stale" ? t("stale") : t(`errors.${result.error}`));
      if (result.error === "stale") setState(null);
    });
  };

  const summaryParts = (summary: Preview["summary"]): string[] => [
    ...(summary.channelsEnabled > 0 ? [t("summary.channelsEnabled", { count: summary.channelsEnabled })] : []),
    ...(summary.channelsDisabled > 0 ? [t("summary.channelsDisabled", { count: summary.channelsDisabled })] : []),
    ...(summary.paramsChanged > 0 ? [t("summary.paramsChanged", { count: summary.paramsChanged })] : []),
    ...(summary.boardsAdded > 0 ? [t("summary.boardsAdded", { count: summary.boardsAdded })] : []),
    ...(summary.boardsRemoved > 0 ? [t("summary.boardsRemoved", { count: summary.boardsRemoved })] : []),
    ...(summary.boardsChanged > 0 ? [t("summary.boardsChanged", { count: summary.boardsChanged })] : []),
    ...(summary.otherChanged > 0 ? [t("summary.otherChanged", { count: summary.otherChanged })] : []),
  ];

  const typeWord = (expected: string): string =>
    expected === "string" || expected === "number" || expected === "boolean" || expected === "array" || expected === "object" ? t(`issues.types.${expected}`) : expected;
  const issueText = (issue: ImportIssue): string => {
    const v = issue.values ?? {};
    switch (issue.code) {
      case "other":
        return t("issues.other", { message: String(v.message ?? issue.message) });
      case "wrong_type":
        return t("issues.wrong_type", { expected: typeWord(String(v.expected)) });
      case "invalid_yaml":
      case "invalid_yaml_at":
      case "invalid_json_at":
      case "too_small":
      case "too_big":
      case "invalid_value":
      case "too_large":
        return t(`issues.${issue.code}`, v);
      default:
        return t(`issues.${issue.code}`);
    }
  };

  const previewState = state?.status === "preview" ? state : null;
  const needsConsent = previewState !== null && previewState.consentChannels.length > 0;
  const consentKinds = previewState === null ? [] : [...new Set(previewState.consentChannels.map((channel) => channel.kind))];
  const canApply = previewState !== null && !previewState.noChanges && !pending && (!needsConsent || acknowledged);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="default" size="sm" data-testid="import-open">
          <Upload aria-hidden />
          {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto max-sm:max-w-[calc(100%-1rem)] sm:max-w-[640px]" data-testid="import-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              id={`${id}-file`}
              type="file"
              accept=".yaml,.yml,.json,application/json,text/yaml"
              className="sr-only"
              onChange={(event) => void readFile(event.target.files?.[0])}
              data-testid="import-file"
            />
            <Button type="button" variant="default" size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp aria-hidden />
              {t("chooseFile")}
            </Button>
            <span className="text-ink-2 font-mono text-data" data-testid="import-file-name">
              {fileName ?? t("orPaste")}
            </span>
          </div>
          <Textarea
            aria-label={t("pasteLabel")}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setFileName(null);
              setState(null);
              setApplyError(null);
              setLocalError(null);
            }}
            spellCheck={false}
            rows={6}
            className="max-h-48 font-mono text-data"
            data-testid="import-text"
          />
          <RadioGroup value={mode} onValueChange={(next) => { setMode(next === "merge_boards" ? "merge_boards" : "replace"); setState(null); }} aria-label={t("modeLabel")} data-testid="import-mode">
            <label className="flex items-start gap-2 text-body-sm">
              <RadioGroupItem value="replace" data-testid="import-mode-replace" />
              <span>
                <b>{t("modeReplace")}</b>
                <span className="text-ink-2 block">{t("modeReplaceHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-body-sm">
              <RadioGroupItem value="merge_boards" data-testid="import-mode-merge" />
              <span>
                <b>{t("modeMerge")}</b>
                <span className="text-ink-2 block">{t("modeMergeHint")}</span>
              </span>
            </label>
          </RadioGroup>
          {localError ? (
            <p role="alert" className="text-bad text-body-sm font-semibold" data-testid="import-local-error">
              {localError}
            </p>
          ) : null}
          <div>
            <Button type="button" variant="primary" size="sm" disabled={pending || text.trim() === ""} aria-busy={pending} onClick={preview} data-testid="import-preview">
              {pending && state === null ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {t("preview")}
            </Button>
          </div>
        </div>

        {state?.status === "error" ? (
          <div role="alert" className="border-bad rounded-card border-bw bg-card p-3" data-testid="import-errors">
            <p className="text-bad text-body-sm font-bold">{state.error === "config_invalid" ? t(`errors.${state.error}`) : t("errorsTitle")}</p>
            <ul className="mt-1 flex flex-col font-mono text-data">
              {state.issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`} className="[overflow-wrap:anywhere]" data-testid="import-issue" data-code={issue.code}>
                  <b>{issue.target ?? (issue.path === "" ? t("wholeFile") : issue.path)}</b>
                  {issue.target && fieldOf(issue.path) ? <span className="text-ink-2"> · {fieldOf(issue.path)}</span> : null}: {issueText(issue)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {previewState ? (
          <div className="flex min-h-0 flex-col gap-2" data-testid="import-preview-box">
            {previewState.noChanges ? (
              <p className="text-body-sm font-bold" data-testid="import-no-changes">
                {t("noChanges")}
              </p>
            ) : (
              <p className="text-body-sm font-bold" data-testid="import-summary">
                {t("summary.prefix")}
                {summaryParts(previewState.summary).join(t("summary.separator"))}
              </p>
            )}
            {(["channel", "board", "other"] as const).map((group) => {
              const items = previewState.changes.filter((change) => change.group === group);
              if (items.length === 0) return null;
              return (
                <section key={group} aria-label={t(`groups.${group}`)} data-testid={`import-group-${group}`}>
                  <h3 className="text-cap-style text-ink-2 mb-1">
                    {t(`groups.${group}`)} · {items.length}
                  </h3>
                  <ul className="border-border max-h-48 overflow-y-auto rounded-tag border-bw px-2">
                    {items.map((change, index) => (
                      <ChangeLine key={`${change.target}-${change.path ?? change.kind}-${index}`} change={change} />
                    ))}
                  </ul>
                </section>
              );
            })}
            {needsConsent && previewState !== null ? (
              <div className="border-bad flex flex-col gap-2 rounded-card border-bw bg-card p-3" data-testid="import-consent">
                <p className="text-body-sm font-bold">{t("consent.title", { channels: previewState.consentChannels.map((channel) => channel.id).join(", ") })}</p>
                {consentKinds.map((kind) => (
                  <p key={kind} className="text-body-sm text-ink-2">
                    {tConsent(kind)}
                  </p>
                ))}
                <p className="text-body-sm text-ink-2">{tConsent.rich("responsibility", { docs: (chunks) => <DocLink doc="scraping">{chunks}</DocLink> })}</p>
                <div className="flex items-start gap-sp-2">
                  <Checkbox id={`${id}-consent`} checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} data-testid="import-consent-ack" />
                  <label htmlFor={`${id}-consent`} className="cursor-pointer text-body-sm font-bold">
                    {t("consent.confirm")}
                  </label>
                </div>
              </div>
            ) : null}
            {previewState.omittedChanges > 0 ? <p className="text-ink-2 text-body-sm">{t("omitted", { count: previewState.omittedChanges })}</p> : null}
            {previewState.notes.map((note) => (
              <p key={note.key} className="text-ink-2 text-body-sm" data-testid={`import-note-${note.key}`}>
                {note.key === "ignoredKeys" ? t("notes.ignoredKeys", { count: note.count }) : t(`notes.${note.key}`)}
              </p>
            ))}
          </div>
        ) : null}

        {applyError ? (
          <p role="alert" className="text-bad text-body-sm font-semibold" data-testid="import-apply-error">
            {applyError}
          </p>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <a href="/sources/registry/export?format=yaml" download className="text-body-sm font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink" data-testid="import-export-first">
            {t("exportFirst")}
          </a>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="default" onClick={() => { setOpen(false); reset(); }} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button type="button" variant="primary" disabled={!canApply} aria-busy={pending && state !== null} onClick={() => previewState && apply(previewState)} data-testid="import-apply">
              {pending && state !== null ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {t("apply")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
