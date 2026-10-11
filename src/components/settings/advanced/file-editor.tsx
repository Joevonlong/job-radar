"use client";

import { Eraser, Lock, Save, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { resetAdvancedAction, saveAdvancedAction, validateAdvancedAction } from "@/app/settings/actions";
import { Button } from "@/components/ui/button";
import { registerUnsaved } from "@/lib/shell/unsaved";
import type { AdvancedFailure, AdvancedFileData, AdvancedLayer, TextIssue } from "@/lib/settings/advanced/types";
import { toastTone } from "@/lib/toast";

import { ConflictBanner } from "./conflict-banner";
import { IssueList } from "./issue-list";
import { OverrideWarning } from "./override-warning";
import { PreviewDialog } from "./preview-dialog";
import { ResetDialog } from "./reset-dialog";
import { YamlTextarea, type YamlTextareaHandle } from "./yaml-textarea";

/** The text is checked on the server this long after the last key stroke. */
const VALIDATE_DEBOUNCE_MS = 400;

interface FileEditorProps {
  data: AdvancedFileData;
  /** The runner's "loaded hh:mm" line for this file (null: nothing to say). */
  ack: ReactNode;
  /** After a save or a restore: the file list and the runner status are refreshed by the parent. */
  onChanged: () => void;
}

interface Base {
  hash: string;
  layer: AdvancedLayer;
  /** The text this base hash belongs to (masked): the left side of the conflict diff. */
  text: string;
}

/** One config file as raw text: edit, live validation, preview, save, restore. All checks that decide anything run on the server. */
export function FileEditor({ data, ack, onChanged }: FileEditorProps) {
  const t = useTranslations("settings.advanced");
  const baseId = useId();
  const editorRef = useRef<YamlTextareaHandle>(null);
  const { stem, file, group } = data.entry;
  const [base, setBase] = useState<Base>({ hash: data.hash, layer: data.layer, text: data.text });
  const [text, setText] = useState(data.text);
  const [issues, setIssues] = useState<TextIssue[]>([]);
  const [warnings, setWarnings] = useState<TextIssue[]>([]);
  // the text the last answer of the server is about: while it differs from the text in the box, a check is pending
  const [checkedText, setCheckedText] = useState<string | null>(null);
  const checking = checkedText !== text;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Exclude<AdvancedFailure, { status: "stale" } | { status: "invalid" }> | null>(null);
  const [conflict, setConflict] = useState<{ text: string; hash: string; layer: AdvancedLayer } | null>(null);
  const requestNo = useRef(0);

  const dirty = text !== base.text;
  const kind = group;
  const firstOverride = kind === "shipped" && base.layer !== "user";
  const canReset = data.defaultText !== null && base.layer === "user" && (kind === "shipped" || base.text !== data.defaultText);

  useEffect(() => {
    if (!dirty) return undefined;
    return registerUnsaved(`advanced-${baseId}`);
  }, [dirty, baseId]);

  // live validation: 0.4 s after the last change, on the server (syntax, schema, cross-file checks, version)
  useEffect(() => {
    const mine = ++requestNo.current;
    const timer = setTimeout(() => {
      void validateAdvancedAction({ file: stem, text }).then((result) => {
        if (mine !== requestNo.current) return;
        setIssues(result.issues);
        setWarnings(result.warnings);
        setCheckedText(text);
      });
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [stem, text]);

  const errorLines = useMemo(() => new Set(issues.filter((issue) => issue.file === undefined).map((issue) => issue.line)), [issues]);
  const canSave = dirty && !checking && issues.length === 0 && !busy;

  const describe = useCallback(
    (issue: TextIssue): string => {
      if (issue.message === "unknown key") return t("reason.unknownKey");
      if (issue.message === "proxies_changed") return t("failure.proxies_changed");
      if (issue.source === "protected") return t("reason.protected", { file });
      if (/received undefined$/.test(issue.message)) return t("reason.missing");
      return issue.message;
    },
    [t, file],
  );

  function openPreview() {
    if (canSave) setPreviewOpen(true);
  }

  function adopt(next: { hash: string; layer: AdvancedLayer; text: string }) {
    setBase(next);
    setText(next.text);
    setConflict(null);
    setFailure(null);
  }

  async function save(confirmOverride: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      const result = await saveAdvancedAction({ file: stem, text, baseHash: base.hash, baseLayer: base.layer, confirmOverride });
      if (result.status === "saved") {
        setPreviewOpen(false);
        adopt({ hash: result.hash, layer: result.layer, text: result.text });
        toastTone("success", t("savedToast", { file }));
        onChanged();
        return;
      }
      setPreviewOpen(false);
      if (result.status === "stale") setConflict(result.current);
      else if (result.status === "invalid") {
        setIssues(result.issues);
        setCheckedText(text);
      } else setFailure(result);
    } finally {
      setBusy(false);
    }
  }

  async function restoreDefault() {
    setBusy(true);
    try {
      const result = await resetAdvancedAction({ file: stem, baseHash: base.hash, baseLayer: base.layer });
      setResetOpen(false);
      if (result.status === "reset") {
        adopt({ hash: result.hash, layer: result.layer, text: result.text });
        toastTone("success", t(kind === "shipped" ? "resetToastShipped" : "resetToastUser", { file }));
        onChanged();
      } else if (result.status === "stale") setConflict(result.current);
      else if (result.status !== "invalid") setFailure(result);
    } finally {
      setBusy(false);
    }
  }

  async function copyMine() {
    try {
      await navigator.clipboard.writeText(text);
      toastTone("success", t("conflict.copied"));
    } catch {
      toastTone("error", t("conflict.copyFailed"));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="advanced-editor" data-file={stem} data-layer={base.layer}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-title font-mono">{file}</h2>
        <span className="text-ink-3 text-data font-mono [overflow-wrap:anywhere]" data-testid="advanced-path">
          {data.path}
        </span>
        <span className="ml-auto">{ack}</span>
      </div>
      {kind === "shipped" ? <OverrideWarning /> : null}
      <p className="text-ink-2 text-body-sm" data-testid="secrets-note">
        {t("secretsNote")}
      </p>
      {data.protectedKeys.length > 0 ? (
        <p className="text-ink-2 text-body-sm" data-testid="protected-note" data-unlocked={data.protectedUnlocked ? "true" : "false"}>
          <Lock aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
          {t(data.protectedUnlocked ? "protectedUnlocked" : "protectedNote", { file })}{" "}
          <span className="font-mono [overflow-wrap:anywhere]">{data.protectedKeys.join(", ")}</span>
        </p>
      ) : null}
      {data.entry.versionBehind ? (
        <p className="text-ink-2 text-body-sm" data-testid="version-note">
          {t("versionNote", { version: data.codeVersion })}
        </p>
      ) : null}

      {conflict ? (
        <ConflictBanner
          opened={base.text}
          current={conflict}
          onLoadLatest={() => adopt({ hash: conflict.hash, layer: conflict.layer, text: conflict.text })}
          onCopyMine={() => void copyMine()}
        />
      ) : null}
      {failure ? (
        <p role="alert" data-testid="advanced-failure" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
          {failure.status === "too_large" ? t("failure.too_large", { max: data.maxBytes }) : t(`failure.${failure.status}`)}
        </p>
      ) : null}

      <YamlTextarea
        ref={editorRef}
        value={text}
        onChange={setText}
        errorLines={errorLines}
        onSave={openPreview}
        ariaLabel={t("editorLabel", { file })}
        ariaDescribedBy={`${baseId}-keys`}
        tabHint={t("tabHint")}
      />
      <p id={`${baseId}-keys`} className="text-ink-3 text-data-sm font-mono">
        {t("keysHint")}
      </p>

      <IssueList issues={issues} warnings={warnings} checking={checking} onJump={(line, col) => editorRef.current?.jumpTo(line, col)} describe={describe} />

      <div className="flex flex-wrap items-center gap-2" data-testid="advanced-actions">
        <Button type="button" variant="primary" size="sm" disabled={!canSave} onClick={openPreview} data-testid="advanced-save">
          <Save aria-hidden /> {t("previewSave")}
        </Button>
        <Button type="button" variant="default" size="sm" disabled={!dirty || busy} onClick={() => setText(base.text)} data-testid="advanced-revert">
          <Undo2 aria-hidden /> {t("revert")}
        </Button>
        <span className="text-ink-3 text-data font-mono" role="status" data-testid="advanced-state">
          {dirty ? t("unsaved") : t("clean")}
        </span>
        {canReset ? (
          <Button type="button" variant="default" size="sm" className="ml-auto" disabled={busy} onClick={() => setResetOpen(true)} data-testid="advanced-reset">
            <Eraser aria-hidden /> {t("resetButton")}
          </Button>
        ) : null}
      </div>

      <PreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        stem={stem}
        text={text}
        firstOverride={firstOverride}
        hasDefault={data.defaultText !== null}
        saving={busy}
        blocked={!canSave}
        onConfirm={(confirmOverride) => void save(confirmOverride)}
        baseHash={base.hash}
        baseLayer={base.layer}
        onStale={(current) => {
          setPreviewOpen(false);
          setConflict(current);
        }}
      />
      {data.defaultText !== null ? <ResetDialog open={resetOpen} onOpenChange={setResetOpen} shipped={kind === "shipped"} current={base.text} defaultText={data.defaultText} pending={busy} onConfirm={() => void restoreDefault()} /> : null}
    </div>
  );
}
