"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";

import { deleteCareerAction, diffVersionAction, historyAction, restoreVersionAction } from "@/app/career/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { resolveLocale } from "@/i18n/locale";
import type { CareerConfig } from "@/lib/config/schemas/career";
import { emptyProfile, hasCareerContent } from "@/lib/career/schema/profile";
import type { loadContact } from "@/lib/career/contact/store";
import type { CareerVersion } from "@/lib/career/store/history";
import type { LoadedCareerProfile } from "@/lib/career/store/profile";
import { formatFullTime } from "@/lib/format/time";
import { CareerGuidance } from "./career-guidance";
import { CareerStatus } from "./career-status";
import { ContactForm } from "./contact-form";
import { careerErrorMessageKey } from "./error-messages";
import { CareerExtraction, type ExtractionView } from "./career-extraction";
import { ProfileForm } from "./profile-form";
import { StoryToProfile } from "./story-to-profile";
import type { StoryOption } from "@/lib/career/apply/from-story";

type Change = { added: boolean; removed: boolean; value: string };
type CareerEditorProps = {
  initial: LoadedCareerProfile | null;
  contact: Awaited<ReturnType<typeof loadContact>> | null;
  initialVersions: CareerVersion[];
  errors: string[];
  limits: CareerConfig["profile"];
  timeZone: string;
  extraction?: ExtractionView;
  stories?: StoryOption[];
};

function DiffLine({ change }: { change: Change }) {
  const t = useTranslations("career");
  let className = "";
  let label: "added" | "removed" | "unchanged" = "unchanged";
  let marker = "  ";
  if (change.added) {
    className = "bg-soft";
    label = "added";
    marker = "+ ";
  } else if (change.removed) {
    className = "bg-hi text-hi-ink line-through";
    label = "removed";
    marker = "- ";
  }
  return (
    <span className={className}>
      <span className="sr-only">{t(label)}</span>
      {marker}
      {change.value}
    </span>
  );
}

export function CareerEditor({ initial, contact, initialVersions, errors, limits, timeZone, extraction, stories }: CareerEditorProps) {
  const t = useTranslations("career");
  const [contactState, setContactState] = useState(contact);
  const locale = resolveLocale(useLocale());
  const [saved, setSaved] = useState(initial);
  const [versions, setVersions] = useState(initialVersions);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<"history" | "all" | null>(null);
  const [pending, startTransition] = useTransition();
  const [adopting, setAdopting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const [revision, setRevision] = useState(0);

  function run(task: () => Promise<void>) {
    startTransition(async () => {
      try {
        await task();
      } catch {
        setMessage("request_failed");
      }
    });
  }

  function clearDiff() {
    setChanges(null);
    setSelected(null);
  }

  async function refreshHistory() {
    const result = await historyAction({});
    if (result.ok) setVersions(result.versions);
    else setMessage(result.code);
  }

  async function showDiff(version: string) {
    const result = await diffVersionAction({ version });
    if (result.ok) {
      setChanges(result.changes);
      setSelected(version);
    } else {
      setMessage(result.code);
    }
  }

  async function restoreVersion(version: string) {
    const result = await restoreVersionAction({ version, baseHash: saved?.baseHash ?? null });
    if (!result.ok) {
      setMessage(result.code);
      return;
    }
    setSaved({ profile: result.profile, baseHash: result.baseHash, updatedAt: null });
    setRevision((old) => old + 1);
    clearDiff();
    setMessage(result.warnings.length ? "history_failed" : "saved");
    await refreshHistory();
  }

  async function deleteData(kind: "history" | "all") {
    const result = await deleteCareerAction({ kind, confirmed: true });
    if (!result.ok) {
      setMessage(result.code);
      return;
    }
    setConfirm(null);
    setVersions([]);
    clearDiff();
    if (kind === "all") {
      setSaved({ profile: emptyProfile(), baseHash: null, updatedAt: null });
      window.location.reload();
    } else {
      setMessage("saved");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <CareerGuidance empty={!saved || !hasCareerContent(saved.profile)} />
      {errors.map((code) => (
        <p key={code} role="alert" data-code={code}>
          {t(careerErrorMessageKey(code))}
        </p>
      ))}
      {saved && extraction && <CareerExtraction contactDirty={contactDirty} onContactSaved={(next) => { setContactDirty(false); setContactState(next); }} view={extraction} profile={saved.profile} baseHash={saved.baseHash} dirty={dirty || pending || adopting} onAdopting={setAdopting} onAdopted={(result) => {
        setSaved({ profile: result.profile, baseHash: result.baseHash, updatedAt: null });
        setRevision((old) => old + 1); setDirty(false); clearDiff(); setMessage(result.warnings.length ? "history_failed" : "saved"); run(refreshHistory);
      }} />}
      {saved && stories && <StoryToProfile onBusy={setAdopting} stories={stories} profile={saved.profile} baseHash={saved.baseHash} dirty={dirty || pending || adopting} onSaved={(result) => {
        setSaved({ profile: result.profile, baseHash: result.baseHash, updatedAt: null });
        setRevision((old) => old + 1); setDirty(false); clearDiff(); setMessage(result.warnings.length ? "history_failed" : "saved"); run(refreshHistory);
      }} />}
      {saved && (
        <ProfileForm
          key={revision}
          disabled={adopting}
          profile={saved.profile}
          baseHash={saved.baseHash}
          limits={limits}
          onDirty={setDirty}
          onSaved={(profile, hash) => {
            setSaved({ profile, baseHash: hash, updatedAt: null });
            clearDiff();
            run(refreshHistory);
          }}
        />
      )}
      {contactState && <ContactForm key={contactState.baseHash ?? "new"} initial={contactState.contact} initialHash={contactState.baseHash} onDirty={setContactDirty} />}
      {dirty && (
        <p role="status" className="text-body-sm">
          {t("unsaved")}
        </p>
      )}
      <Card data-testid="career-history">
        <CardHeader>
          <CardTitle>{t("history")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={pending || adopting} onClick={() => run(refreshHistory)}>
            {t("refresh")}
          </Button>
          {versions.length === 0 ? (
            <p>{t("noHistory")}</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-3">
              {versions.map((version) => (
                <li
                  key={version.id}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-card border-bw border-grid p-3"
                >
                  <time className="font-mono text-data" dateTime={version.createdAt}>
                    {formatFullTime(version.createdAt, { locale, timeZone })}
                  </time>
                  <span className="max-w-full break-all font-mono text-data">{version.hash}</span>
                  <Button variant="outline" disabled={pending || adopting} onClick={() => run(() => showDiff(version.id))}>
                    {t("diff")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={pending || adopting || !saved || dirty}
                    onClick={() => run(() => restoreVersion(version.id))}
                  >
                    {t("restore")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {changes && (
            <section data-testid="career-diff" aria-label={t("diffTitle")} className="min-w-0">
              <h3 className="text-title">{t("diffTitle")}</h3>
              <span className="sr-only">{selected}</span>
              <pre className="max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-card border-bw border-grid p-3 text-data">
                {changes.map((change, index) => (
                  <DiffLine key={index} change={change} />
                ))}
              </pre>
            </section>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("delete")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body-sm">{t("deleteNote")}</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" disabled={pending || adopting} onClick={() => setConfirm("history")}>
              {t("clearHistory")}
            </Button>
            <Button variant="outline" disabled={pending || adopting} onClick={() => setConfirm("all")}>
              {t("deleteProfile")}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t(confirm === "history" ? "clearHistoryTitle" : "deleteProfileTitle")}</DialogTitle>
          <DialogDescription>
            {t(confirm === "history" ? "clearHistoryDescription" : "deleteProfileDescription")}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={pending || adopting}>
              {t("cancel")}
            </Button>
            <Button
              disabled={pending || adopting}
              onClick={() => {
                if (confirm) run(() => deleteData(confirm));
              }}
            >
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CareerStatus code={message} />
    </div>
  );
}
