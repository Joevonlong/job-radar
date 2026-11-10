"use client";

import { createContext, useContext, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { markOf } from "@/lib/career/document/marks";
import type { Claim, DocText } from "@/lib/career/schema/document";

export type ClaimEntry = { id: string; label: string };
export type ClaimControls = {
  claims: Claim[];
  disabled: boolean;
  entries: ClaimEntry[];
  defaultEntry: (textId: string) => string | null;
  run: (body: Record<string, unknown>) => Promise<string | null>;
};

const ClaimContext = createContext<ClaimControls | null>(null);
export const ClaimProvider = ClaimContext.Provider;

const ERRORS = new Set(["unresolved_claims", "target_gone", "stale", "limits"]);

function useClaimError() {
  const t = useTranslations("career.claims");
  return (code: string) => t(`errors.${ERRORS.has(code) ? code as "unresolved_claims" | "target_gone" | "stale" | "limits" : "generic"}`);
}

/** One claim as a line: what kind of content the profile lacks, the words, and whether only the JD has them. */
export function ClaimLine({ claim, children }: { claim: Claim; children?: React.ReactNode }) {
  const t = useTranslations("career.claims");
  return (
    <li data-testid="claim-line" data-status={claim.status} className="flex min-w-0 flex-wrap items-center gap-2 text-body-sm">
      <Badge variant={claim.status === "pending" && claim.by === "ai" ? "gate-bad" : "tag"}>{t(`kinds.${claim.kind}`)}</Badge>
      <span className="min-w-0 break-words">{claim.text}</span>
      {claim.in_jd && <Badge variant="gate-warn">{t("inJd")}</Badge>}
      {claim.translation && <Badge variant="gate-note">{t("translation")}</Badge>}
      <span className="text-ink-2">{t(`status.${claim.status}`)}</span>
      {children}
    </li>
  );
}

function ClaimDecision({ claim, controls, onError }: { claim: Claim; controls: ClaimControls; onError: (code: string | null) => void }) {
  const t = useTranslations("career.claims");
  const [busy, setBusy] = useState(false);
  if (claim.by !== "ai") return null;
  async function decide(status: "confirmed" | "rejected") {
    setBusy(true);
    try { onError(await controls.run({ action: "claim", claim_id: claim.id, status })); }
    finally { setBusy(false); }
  }
  return (
    <>
      {claim.status !== "confirmed" && <Button size="sm" variant="outline" disabled={busy || controls.disabled} onClick={() => void decide("confirmed")}>{t("confirm")}</Button>}
      {claim.status === "pending" && <Button size="sm" variant="ghost" disabled={busy || controls.disabled} onClick={() => void decide("rejected")}>{t("reject")}</Button>}
    </>
  );
}

/** The mark of one document text and its claims; marks live only in the editor, never in the preview or the PDF. */
export function ClaimMarks({ value }: { value: DocText }) {
  const controls = useContext(ClaimContext);
  const t = useTranslations("career.claims");
  const id = useId();
  const message = useClaimError();
  const [failure, setFailure] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!controls || !value.id) return null;
  const mark = markOf(value, controls.claims);
  const claims = controls.claims.filter((claim) => "text" in claim.target && claim.target.text === value.id);
  const chosen = target ?? controls.defaultEntry(value.id) ?? controls.entries[0]?.id ?? null;
  async function saveBack() {
    setBusy(true);
    try { setFailure(await controls!.run({ action: "save_back", text_id: value.id, ...(value.source ? {} : chosen ? { target: chosen } : {}) })); }
    finally { setBusy(false); }
  }
  const showMark = mark !== "verbatim" && !(mark === "user_written" && value.origin === "user");
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="claim-marks">
      {showMark && (
        <Badge data-testid="claim-mark" data-mark={mark} variant={mark === "unverified" ? "gate-bad" : mark === "confirmed" ? "status-good" : "tag"}>
          {t(`marks.${mark}`)}
        </Badge>
      )}
      {claims.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1" aria-label={t("listLabel")}>
          {claims.map((claim) => (
            <ClaimLine key={claim.id} claim={claim}>
              <ClaimDecision claim={claim} controls={controls} onError={setFailure} />
            </ClaimLine>
          ))}
        </ul>
      )}
      {value.origin !== "source" && (
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          {!value.source && controls.entries.length > 0 && (
            <label htmlFor={`${id}-entry`} className="flex min-w-0 flex-col gap-1 text-label">
              {t("saveBackEntry")}
              <NativeSelect id={`${id}-entry`} value={chosen ?? ""} onChange={(event) => setTarget(event.target.value)}>
                {controls.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </NativeSelect>
            </label>
          )}
          <Button size="sm" variant="outline" disabled={busy || controls.disabled || (!value.source && !chosen)} onClick={() => void saveBack()}>{t("saveBack")}</Button>
        </div>
      )}
      {failure && <p role="alert" data-code={failure} className="break-words text-body-sm text-bad">{message(failure)}</p>}
    </div>
  );
}

/** Claims on plain fields (a stack, a skill list, a letter field), which have no text box of their own. */
export function ClaimSummary({ labels }: { labels: (claim: Claim) => string }) {
  const controls = useContext(ClaimContext);
  const t = useTranslations("career.claims");
  const message = useClaimError();
  const [failure, setFailure] = useState<string | null>(null);
  if (!controls) return null;
  const claims = controls.claims.filter((claim) => !("text" in claim.target));
  if (!claims.length) return null;
  return (
    <section aria-label={t("fieldClaims")} data-testid="claim-summary" className="flex min-w-0 flex-col gap-2 rounded-card border-bw border-grid p-3">
      <p className="text-label">{t("fieldClaims")}</p>
      <ul className="flex min-w-0 flex-col gap-1">
        {claims.map((claim) => (
          <ClaimLine key={claim.id} claim={claim}>
            <span className="text-ink-2">{labels(claim)}</span>
            <ClaimDecision claim={claim} controls={controls} onError={setFailure} />
          </ClaimLine>
        ))}
      </ul>
      {failure && <p role="alert" data-code={failure}>{message(failure)}</p>}
    </section>
  );
}
