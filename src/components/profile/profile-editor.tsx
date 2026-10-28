"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useEffect } from "react";
import { toastTone } from "@/lib/toast";

import { rollbackAction as rawRollbackAction, saveMeAction as rawSaveMeAction, savePreferencesAction as rawSavePreferencesAction } from "@/app/me/actions";
import type { SalaryAxisScale } from "@/components/viz";
import type { MarketView } from "@/lib/market/view";
import type { MeDraft, PreferencesDraft } from "@/lib/profile/draft";
import type { SalaryMedian, StatedSalary } from "@/lib/profile/floor-preview";
import { IDLE_ACTION_STATE, type ProfileSection } from "@/lib/profile/types";

import { HistoryPanel } from "./history-panel";
import { MeForm } from "./me-form";
import { PreferencesForm } from "./preferences-form";
import { withActionFeedback } from "@/lib/actions/client";

const rollbackAction = withActionFeedback(rawRollbackAction)((previous) => previous);
const saveMeAction = withActionFeedback(rawSaveMeAction)((previous) => previous);
const savePreferencesAction = withActionFeedback(rawSavePreferencesAction)((previous) => previous);

interface ProfileEditorProps {
  me: ProfileSection<MeDraft>;
  preferences: ProfileSection<PreferencesDraft>;
  staleScores: number;
  dbAvailable: boolean;
  /** This month's stated salaries (the floor preview) and the salary axis scale. */
  salaries: readonly StatedSalary[];
  axis: SalaryAxisScale;
  /** The median of this month's comparable salaries (`summarizeMonthSalaries`), the one definition of the detail page. */
  salaryMedian: SalaryMedian;
  /** The market (scope choices, currency, language). */
  market: MarketView;
  /** search.yaml `locations`: the cities that are searched. */
  searchLocations: readonly string[];
  /** The user's level of the market's local language in me.yaml, null = none listed (the deal-breakers' language gate). */
  userLanguageLevel: string | null;
}

function LoadError({ file, message }: { file: string; message: string }) {
  const t = useTranslations("profile.loadError");
  return (
    <div role="alert" className="border-bad bg-card flex flex-col gap-1 rounded-card border-bw px-4 py-3 text-body">
      <p className="text-bad flex items-center gap-2 font-bold">
        <AlertTriangle aria-hidden className="size-4" />
        {t("title", { file })}
      </p>
      <p className="text-ink-2">{t("hint")}</p>
      <pre className="text-ink-2 mt-1 font-mono text-data break-words whitespace-pre-wrap">{message}</pre>
    </div>
  );
}

function StaleBanner({ count }: { count: number }) {
  const t = useTranslations("profile.stale");
  if (count <= 0) return null;
  return (
    <div
      role="status"
      data-testid="stale-banner"
      className="border-border bg-card flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border-bw px-4 py-2.5 text-body shadow-e1"
    >
      <RefreshCw aria-hidden className="size-4 shrink-0" />
      <span className="font-bold">{t("title", { count })}</span>
      <span className="text-ink-2">{t("hint")}</span>
      <Link href="/settings?tab=actions#rescore" className="ml-auto font-bold underline decoration-2 underline-offset-4 hover:bg-hi">
        {t("link")}
      </Link>
    </div>
  );
}

/**
 * The /me page body. The three Server Actions live here (not in the forms) so their state survives
 * the remount that follows every save or rollback: a form is keyed by the hash of its file.
 */
export function ProfileEditor({ me, preferences, staleScores, dbAvailable, salaries, axis, salaryMedian, market, searchLocations, userLanguageLevel }: ProfileEditorProps) {
  const t = useTranslations("profile");
  const [meState, saveMe, mePending] = useActionState(saveMeAction, IDLE_ACTION_STATE);
  const [prefState, savePrefs, prefPending] = useActionState(savePreferencesAction, IDLE_ACTION_STATE);
  const [rollbackState, rollback, rollbackPending] = useActionState(rollbackAction, IDLE_ACTION_STATE);

  useEffect(() => {
    if (meState.status === "saved") toastTone("success", t("actions.savedToast"), { id: `me-${meState.nonce}` });
  }, [meState, t]);
  useEffect(() => {
    if (prefState.status === "saved") toastTone("success", t("actions.savedToast"), { id: `prefs-${prefState.nonce}` });
  }, [prefState, t]);
  useEffect(() => {
    if (rollbackState.status === "saved") toastTone("success", t("actions.rolledBackToast"), { id: `rollback-${rollbackState.nonce}` });
    if (rollbackState.status === "error" && rollbackState.formError) {
      toastTone("error", t(`formErrors.${rollbackState.formError}`));
    }
  }, [rollbackState, t]);

  const busy = mePending || prefPending || rollbackPending;
  const lastSaved = [meState, prefState, rollbackState]
    .flatMap((state) => (state.status === "saved" ? [{ kind: state.kind, nonce: state.nonce }] : []))
    .sort((a, b) => b.nonce - a.nonce)[0];

  return (
    <div className="flex flex-col gap-4">
      <StaleBanner count={staleScores} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {me.draft ? (
            <MeForm
              key={me.hash}
              initial={me.draft}
              hash={me.hash}
              state={meState}
              pending={mePending || rollbackPending}
              onSave={(draft) => saveMe({ draft, baseHash: me.hash })}
            />
          ) : (
            <LoadError file="me.yaml" message={me.loadError ?? ""} />
          )}
          {preferences.draft ? (
            <PreferencesForm
              key={preferences.hash}
              initial={preferences.draft}
              hash={preferences.hash}
              state={prefState}
              pending={prefPending || rollbackPending}
              onSave={(draft) => savePrefs({ draft, baseHash: preferences.hash })}
              salaries={salaries}
              axis={axis}
              salaryMedian={salaryMedian}
              market={market}
              searchLocations={searchLocations}
              userLanguageLevel={userLanguageLevel}
              needsVisaSponsorship={me.draft?.needs_visa_sponsorship ?? null}
            />
          ) : (
            <LoadError file="preferences.yaml" message={preferences.loadError ?? ""} />
          )}
        </div>
        <div className="min-w-0 lg:sticky lg:top-20">
          <HistoryPanel
            dbAvailable={dbAvailable}
            pending={busy}
            follow={lastSaved ?? null}
            sections={[
              { kind: "me", title: t("sections.me.title"), history: me.history },
              { kind: "preferences", title: t("sections.preferences.title"), history: preferences.history },
            ]}
            onRollback={(kind, snapshotId) => rollback({ kind, snapshotId })}
          />
        </div>
      </div>
    </div>
  );
}
