"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  deleteDocumentAction,
  documentHistoryAction,
  restoreDocumentVersionAction,
  saveDocumentAction,
} from "@/app/career/documents/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SourceStates } from "@/lib/career/document/resolve";
import type { CareerDocument } from "@/lib/career/schema/document";
import type { CareerPreferences } from "@/lib/career/schema/preferences";
import type { LoadedDocument } from "@/lib/career/store/documents";
import type { CareerVersion } from "@/lib/career/store/history";
import { resolveLocale } from "@/i18n/locale";
import { formatFullTime } from "@/lib/format/time";
import { registerUnsaved } from "@/lib/shell/unsaved";
import { cn } from "@/lib/utils";
import { DocumentContent, DocumentContact } from "./document-fields";
import { DocumentImages } from "./document-images";
import { DocumentLayout } from "./document-layout";
import { DocumentLetter } from "./document-letter";
import type { DocumentFinding } from "@/lib/career/render/check-result";
import { DocumentExport } from "./document-export";
import { DocumentPreview } from "./document-preview";
import { DocumentConfirm, DocumentStatus } from "./document-shared";
import { ClaimProvider, ClaimSummary, type ClaimControls, type ClaimEntry } from "./claim-marks";
import { TranslationConfirm } from "./claim-translation";
import { objectLabel } from "./proposal-review";
import { tailorAction } from "./tailor-api";
import { ShrinkButton } from "./tailor-shrink";
import { documentObjects, documentTexts } from "@/lib/career/document/targets";

type Props = {
  initial: LoadedDocument;
  initialStates: SourceStates;
  initialVersions: CareerVersion[];
  preferences: { preferences: CareerPreferences; baseHash: string | null };
  images: { photo: boolean; signature: boolean };
  debounceMs: number;
  pageCountDebounceMs: number;
  imageMaxBytes: number;
  timeZone: string;
  warnings: string[];
  hasProposals?: boolean;
  profileEntries?: ClaimEntry[];
  pageCount?: number | null;
};

export function DocumentEditor({
  initial,
  initialStates,
  initialVersions,
  preferences,
  images,
  debounceMs,
  pageCountDebounceMs,
  imageMaxBytes,
  timeZone,
  warnings,
  hasProposals = false,
  profileEntries = [],
  pageCount = null,
}: Props) {
  const t = useTranslations("career.documents");
  const locale = resolveLocale(useLocale());
  const router = useRouter();
  const guardId = useId();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial.document);
  const [states, setStates] = useState(initialStates);
  const [versions, setVersions] = useState(initialVersions);
  const [tab, setTab] = useState("content");
  const [previewDoc, setPreviewDoc] = useState<"resume" | "letter">("resume");
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [imageRevision, setImageRevision] = useState(0);
  const [countRevision, setCountRevision] = useState(0);
  const [measuredPages, setMeasuredPages] = useState<number | null>(null);
  const hintKey = JSON.stringify({ draft, previewDoc, imageRevision });
  const [hints, setHints] = useState<{ key: string; findings: DocumentFinding[]; uncovered: string[] }>({
    key: "", findings: [], uncovered: [],
  });
  const receiveHints = useCallback((value: { findings: DocumentFinding[]; uncovered: string[] }) => {
    setHints({ ...value, key: hintKey });
  }, [hintKey]);
  const locked = pending || exporting;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.document);
  useEffect(() => (dirty ? registerUnsaved(guardId) : undefined), [dirty, guardId]);
  function change(document: CareerDocument) {
    setDraft(document);
    if (status !== "stale") setStatus("");
  }
  function selectTab(value: string) {
    setTab(value);
    if (value === "letter") setPreviewDoc("letter");
    if (value === "content") setPreviewDoc("resume");
  }
  function run(task: () => Promise<unknown>) {
    startTransition(async () => {
      try {
        await task();
      } catch {
        setStatus("request_failed");
      }
    });
  }
  async function history() {
    const result = await documentHistoryAction({ id: draft.id });
    if (result.ok) setVersions(result.versions);
    else setStatus(result.code);
  }
  async function persist(version?: string) {
    const result = version
      ? await restoreDocumentVersionAction({ id: draft.id, version, baseHash: saved.baseHash })
      : await saveDocumentAction({ id: draft.id, document: draft, baseHash: saved.baseHash });
    if (!result.ok) {
      setStatus(result.code);
      return false;
    }
    setSaved({ document: result.document, baseHash: result.baseHash });
    setDraft(result.document);
    setStates(result.states);
    setStatus(result.warnings[0] ?? "saved");
    await history();
    return true;
  }
  function adopt(next: LoadedDocument) {
    setSaved(next);
    setDraft(next.document);
    setStatus("saved");
  }
  const claimControls: ClaimControls = {
    claims: saved.document.claims,
    disabled: pending || dirty || status === "stale",
    entries: profileEntries,
    defaultEntry: (textId) => {
      const entry = documentTexts(saved.document).find((item) => item.value.id === textId)?.entry;
      const source = entry ? documentObjects(saved.document).get(entry)?.source : null;
      const id = source && typeof source === "object" && "entry_id" in source ? String(source.entry_id) : null;
      return id && profileEntries.some((item) => item.id === id) ? id : null;
    },
    run: async (body) => {
      const result = await tailorAction({ ...body, doc_id: saved.document.id, baseHash: saved.baseHash });
      if (!result.ok) return result.error;
      if ("document" in result) adopt({ document: result.document, baseHash: result.baseHash });
      return null;
    },
  };
  async function remove() {
    const result = await deleteDocumentAction({ id: draft.id, confirmed: true });
    if (!result.ok) {
      setStatus(result.code);
      return;
    }
    setSaved({ ...saved, document: draft });
    setConfirm(false);
    router.push("/career/documents");
    router.refresh();
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="document-editor">
      <Link href="/career/documents" className="underline">
        {t("back")}
      </Link>
      {warnings.map((code, index) => (
        <DocumentStatus key={index} code={code} />
      ))}
      {hasProposals && (
        <p role="status" data-testid="document-proposals" className="rounded-card border-bw border-grid bg-soft p-3 text-body-sm">
          {t("proposalsWaiting")}{" "}
          <Link href={`/career/tailor?doc=${draft.id}`} className="underline">
            {t("reviewProposals")}
          </Link>
        </p>
      )}
      {states.profileChanged && (
        <p role="status" className="rounded-card border-bw border-grid bg-soft p-3 text-body-sm">
          {t("profileChanged")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={locked || status === "stale"} onClick={() => run(() => persist())}>
          {t(pending ? "saving" : "save")}
        </Button>
        <DocumentStatus code={status || (dirty ? "unsaved" : "")} />
        <Button variant="outline" disabled={locked} onClick={() => setConfirm(true)}>
          {t("delete")}
        </Button>
        <Link href={`/career/tailor?doc=${draft.id}`} className="underline">
          {t("tailor")}
        </Link>
        <ShrinkButton docId={draft.id} budget={draft.layout.pages} pageCount={pageCount ?? measuredPages} />
      </div>
      <TranslationConfirm document={saved.document} baseHash={saved.baseHash} disabled={claimControls.disabled} onSaved={adopt} />
      {dirty && saved.document.claims.length > 0 && <p className="text-body-sm">{t("saveBeforeMarks")}</p>}
      <DocumentExport
        document={draft}
        disabled={locked || status === "stale"}
        findings={hints.key === hintKey ? hints.findings : []}
        uncovered={hints.key === hintKey ? hints.uncovered : []}
        onBusy={setExporting}
        onSave={async () => dirty ? await persist() : true}
        onExported={(doc) => {
          setPreviewDoc(doc);
          setCountRevision((value) => value + 1);
        }}
      />
      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList className="max-w-full overflow-x-auto">
          {(["content", "letter", "layout", "preview"] as const).map((key) => (
            <TabsTrigger
              key={key}
              value={key}
              className={cn("px-2.5", (key === "layout" || key === "preview") && "lg:hidden")}
            >
              {t(key)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ClaimProvider value={claimControls}>
      <ClaimSummary labels={(claim) => ("letter" in claim.target ? t(`letterFields.${claim.target.letter}`) : "entry" in claim.target ? objectLabel(saved.document, claim.target.entry) : "")} />
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <div className={cn("min-w-0", tab !== "content" && tab !== "letter" && "hidden lg:block")}>
          <Card>
            <CardHeader>
              <CardTitle>{t(tab === "letter" ? "letter" : "content")}</CardTitle>
            </CardHeader>
            <CardContent>
              <fieldset disabled={locked} className="flex min-w-0 flex-col gap-6">
                {tab === "letter" ? (
                  <DocumentLetter
                    letter={draft.letter}
                    states={states}
                    onChange={(letter) => change({ ...draft, letter })}
                  />
                ) : (
                  <>
                    <DocumentContent document={draft} states={states} onChange={change} />
                    <DocumentContact
                      value={draft.hide_contact}
                      onChange={(hide_contact) => change({ ...draft, hide_contact })}
                    />
                  </>
                )}
              </fieldset>
              <div className={tab === "letter" ? "hidden" : ""}>
                <DocumentImages
                  initial={images}
                  maxBytes={imageMaxBytes}
                  onChange={() => setImageRevision((old) => old + 1)}
                />
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Card className={cn(tab !== "layout" && "hidden lg:flex")}>
            <CardHeader>
              <CardTitle>{t("layout")}</CardTitle>
            </CardHeader>
            <CardContent>
              <fieldset disabled={locked} className="min-w-0">
                <DocumentLayout
                  document={draft}
                  onChange={(layout) => change({ ...draft, layout })}
                  initialPreferences={preferences}
                />
              </fieldset>
            </CardContent>
          </Card>
          <div className={cn(tab !== "preview" && "hidden lg:block")}>
            <DocumentPreview
              document={draft}
              doc={previewDoc}
              debounceMs={debounceMs}
              pageCountDebounceMs={pageCountDebounceMs}
              revision={imageRevision}
              countRevision={countRevision}
              onHints={receiveHints}
              onPageCount={setMeasuredPages}
            />
          </div>
        </div>
      </div>
      </ClaimProvider>
      <Card data-testid="document-history">
        <CardHeader>
          <CardTitle>{t("history")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={locked} onClick={() => run(history)}>
            {t("refresh")}
          </Button>
          {versions.length ? (
            <ul className="flex min-w-0 flex-col gap-2">
              {versions.map((version) => (
                <li key={version.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <time dateTime={version.createdAt}>{formatFullTime(version.createdAt, { locale, timeZone })}</time>
                  <span className="font-mono text-data">{version.hash}</span>
                  <Button
                    variant="outline"
                    disabled={locked || dirty || status === "stale"}
                    onClick={() => run(() => persist(version.id))}
                  >
                    {t("restore")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("noHistory")}</p>
          )}
        </CardContent>
      </Card>
      <DocumentConfirm
        open={confirm}
        title={t("delete")}
        pending={locked}
        onClose={() => setConfirm(false)}
        onConfirm={() => run(remove)}
      />
    </div>
  );
}
