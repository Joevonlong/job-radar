"use client";

import { Check, Copy, FileText, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { attachResumePdfAction, detachResumePdfAction, exportResumeKitAction, type ExportResumeResult } from "@/app/jobs/[id]/resume-actions";
import { PlaceholderBox } from "@/components/jobs/detail/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ResumeChip } from "./resume-chip";

interface ResumePanelProps {
  jobId: number;
  /** `applications.resume_variant_path`, or null. */
  resumePath: string | null;
  /** Attaching is possible (`pdf_dir` is configured). */
  pdfEnabled: boolean;
  /** PDF file names of `pdf_dir` for the picker (newest first). */
  pdfs: string[];
}

type ExportSuccess = Extract<ExportResumeResult, { ok: true }>;

/** "定制简历": export the JD, copy the `/tailor` command, attach the finished PDF. */
export function ResumePanel({ jobId, resumePath, pdfEnabled, pdfs }: ResumePanelProps) {
  const t = useTranslations("resume");
  const tStatus = useTranslations("dashboard.status");
  const [exported, setExported] = useState<ExportSuccess | null>(null);
  const [copied, setCopied] = useState(false);
  const [pdfInput, setPdfInput] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
  const [exporting, startExport] = useTransition();
  const [attaching, startAttach] = useTransition();
  const [detaching, startDetach] = useTransition();

  const runExport = (): void => {
    startExport(async () => {
      let result: ExportResumeResult;
      try {
        result = await exportResumeKitAction({ jobId });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (result.ok) {
        setExported(result);
        setCopied(false);
        toast.success(t("exported"));
      } else {
        toast.error(t(`error.${result.error}`));
      }
    });
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const attach = (): void => {
    setAttachError(null);
    startAttach(async () => {
      let result: Awaited<ReturnType<typeof attachResumePdfAction>>;
      try {
        result = await attachResumePdfAction({ jobId, path: pdfInput });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (result.ok) {
        setPdfInput("");
        toast.success(t("attached", { name: result.name }));
      } else {
        setAttachError(t(`error.${result.error}`));
      }
    });
  };

  const detach = (): void => {
    startDetach(async () => {
      let result: Awaited<ReturnType<typeof detachResumePdfAction>>;
      try {
        result = await detachResumePdfAction({ jobId });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (result.ok) toast.success(t("detached"));
      else toast.error(t(`error.${result.error}`));
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="resume-panel">
      <div className="flex flex-col gap-2">
        <Button type="button" onClick={runExport} disabled={exporting} aria-busy={exporting} data-testid="resume-export">
          {exporting ? <Loader2 aria-hidden className="animate-spin" /> : <FileText aria-hidden />}
          {exporting ? t("exporting") : t("export")}
        </Button>
        <p className="text-muted-foreground text-xs">{t("exportHint")}</p>
      </div>

      {exported ? (
        <div className="border-border flex flex-col gap-3 border-t pt-3" data-testid="resume-export-result">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("jdPath")}</span>
            <code className="bg-muted rounded-sm px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]" data-testid="resume-jd-path">
              {exported.jdPath}
            </code>
          </div>
          <p className="text-muted-foreground text-xs" data-testid="resume-status-note">
            {exported.statusChanged ? t("statusSet", { status: tStatus("preparing") }) : exported.status === "preparing" ? t("statusAlready", { status: tStatus("preparing") }) : t("statusKept", { status: tStatus(exported.status) })}
          </p>
          {exported.command ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">{t("commandLabel")}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void copy(exported.command ?? "")} data-testid="resume-copy">
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied ? t("copied") : t("copy")}
                </Button>
              </div>
              <pre className="bg-muted overflow-x-auto rounded-sm px-2 py-1.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="resume-command">
                {exported.command}
              </pre>
              <p className="text-muted-foreground text-xs" data-testid="resume-untrusted-hint">
                {t("untrustedHint")}
              </p>
            </div>
          ) : (
            <PlaceholderBox testId="resume-no-kit">{t("noKit")}</PlaceholderBox>
          )}
        </div>
      ) : null}

      <div className="border-border flex flex-col gap-2 border-t pt-3">
        <h3 className="font-medium">{t("attachTitle")}</h3>
        {resumePath ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="resume-current">
            <ResumeChip path={resumePath} />
            <Button type="button" variant="ghost" size="sm" onClick={detach} disabled={detaching} data-testid="resume-detach">
              {t("detach")}
            </Button>
          </div>
        ) : null}
        {pdfEnabled ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              attach();
            }}
          >
            <label htmlFor="resume-pdf" className="text-muted-foreground text-xs">
              {t("attachLabel")}
            </label>
            <Input
              id="resume-pdf"
              name="pdf"
              list="resume-pdf-options"
              value={pdfInput}
              onChange={(event) => {
                setPdfInput(event.target.value);
                setAttachError(null);
              }}
              placeholder={t("attachPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={attachError !== null}
              data-testid="resume-pdf-input"
            />
            <datalist id="resume-pdf-options">
              {pdfs.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {attachError ? (
              <p className="text-destructive text-xs" role="alert" data-testid="resume-attach-error">
                {attachError}
              </p>
            ) : null}
            <Button type="submit" variant="outline" size="sm" className="self-start" disabled={attaching || pdfInput.trim() === ""} data-testid="resume-attach">
              {attaching ? t("attaching") : t("attach")}
            </Button>
          </form>
        ) : (
          <PlaceholderBox testId="resume-no-pdf-dir">{t("noPdfDir")}</PlaceholderBox>
        )}
      </div>
    </div>
  );
}
