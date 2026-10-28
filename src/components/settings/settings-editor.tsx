"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, WifiOff } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useActionState, useEffect } from "react";
import { toastTone } from "@/lib/toast";

import { saveSettingsAction as rawSaveSettingsAction } from "@/app/settings/actions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AiDisclosureRow } from "@/lib/ai/disclosure";
import type { ControlStatus } from "@/lib/settings/status-schema";
import { ACTIONS_TAB, ADVANCED_TAB, CONFIG_PAGE_TABS, PAGE_TABS, SETTINGS_FILES, TAB_LAYOUT, WEB_ONLY_CONFIGS, isAckName, type PageTab } from "@/lib/settings/tabs";
import type { QuietInput } from "@/lib/settings/timeline";
import type { WorkflowView } from "@/lib/settings/workflow/types";
import { IDLE_SETTINGS_STATE, type SaveSettingsRequest, type SettingsSection } from "@/lib/settings/types";

import type { TelegramStatusView } from "@/lib/notify/telegram-status";
import type { CatalogView } from "@/lib/settings/catalog-view";

import { TelegramStatus } from "@/components/notify/telegram-status";
import { SetupWizardCard } from "@/components/setup/setup-wizard-card";

import { ActionsPanel } from "./actions-panel";
import { AdvancedPanel } from "./advanced/advanced-panel";
import { ConfigForm, type ProviderStates } from "./config-form";
import { useControlStatus } from "./use-control-status";
import { WorkflowPanel } from "./workflow/workflow-panel";
import { withActionFeedback } from "@/lib/actions/client";

const saveSettingsAction = withActionFeedback(rawSaveSettingsAction)((previous) => previous);

interface SettingsEditorProps {
  sections: SettingsSection[];
  status: ControlStatus | null;
  channelChoices: string[];
  /** Availability of the AI providers (marked in the AI tab). */
  providerStates?: ProviderStates;
  /** Current scores that changed scoring criteria would re-score (null: unknown). */
  criteriaImpact?: number | null;
  /** Per AI task the providers that may receive job text (null: ai.yaml cannot be read). */
  aiDisclosure?: AiDisclosureRow[] | null;
  /** The model catalog for the AI tab (null = models.yaml cannot be read, see `catalogError`). */
  catalog?: CatalogView | null;
  catalogError?: string | null;
  /** Data of the application workflow panel. */
  workflow: WorkflowView;
  /** Telegram status and setup guidance on the Notifications tab (absent: not shown). */
  telegram?: TelegramStatusView | null;
  timezone: string;
  /** Server time at render (ISO): the first paint of the timeline's "now" line. */
  now: string;
}

/** The advanced editor's address for a config (`?tab=advanced&file=<file name without .yaml>`). */
function repairHref(file: string): string {
  return `/settings?tab=advanced&file=${encodeURIComponent(file.replace(/\.yaml$/, ""))}`;
}

function LoadError({ file, repair, message }: { file: string; repair: string; message: string }) {
  const t = useTranslations("settings.loadError");
  return (
    <div role="alert" className="border-bad bg-card flex flex-col gap-1 rounded-card border-bw px-4 py-3 text-body">
      <p className="text-bad flex items-center gap-2 font-bold [overflow-wrap:anywhere]">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />
        {t("title", { file })}
      </p>
      <p className="text-ink-2">{t("hint")}</p>
      <pre className="text-ink-2 mt-1 font-mono text-data break-words whitespace-pre-wrap">{message}</pre>
      <Link href={repairHref(repair)} className="font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink" data-testid="repair-link">
        {t("repair")}
      </Link>
    </div>
  );
}

const ACK_BASE = "flex items-center gap-1.5 font-mono text-data";
/** The note sits on the black strip under a form ("terminal") or on a paper card ("paper"): each needs text colours that read on it. */
const ACK_TONES = {
  terminal: { dim: `text-term-dim ${ACK_BASE}`, ok: `text-term-green ${ACK_BASE}`, wait: `text-term-amber ${ACK_BASE}` },
  paper: { dim: `text-ink-3 ${ACK_BASE}`, ok: `text-good ${ACK_BASE}`, wait: `text-warning-text ${ACK_BASE}` },
} as const;

/**
 * "Runner has loaded this (hh:mm)" for one file: the hot-reload acknowledgement. It never contradicts the runner's heartbeat:
 * a silent runner is said so, whatever it acknowledged earlier. `ui.yaml` is read by the web app itself, so it gets a web note.
 */
function AckLine({ tab, status, timezone, testPrefix = "ack", surface = "terminal" }: { tab: string; status: ControlStatus | null; timezone: string; testPrefix?: string; surface?: "terminal" | "paper" }) {
  const t = useTranslations("settings.ack");
  const tone = ACK_TONES[surface];
  const format = useFormatter();
  if ((WEB_ONLY_CONFIGS as readonly string[]).includes(tab)) {
    return (
      <p className={tone.dim} data-testid={`${testPrefix}-${tab}`} data-state="web">
        <CheckCircle2 aria-hidden className="size-3.5" /> {t("web")}
      </p>
    );
  }
  if (status === null) return null;
  // the advanced editor names sources.yaml "sources"; the runner acknowledges it as "channels"
  const ackName = tab === "sources" ? "channels" : tab;
  const ack = isAckName(ackName) ? status.acks[ackName] : undefined;
  const online = status.heartbeat.online;

  if (!online) {
    return (
      <p className={tone.dim} data-testid={`${testPrefix}-${tab}`} data-state="offline">
        <WifiOff aria-hidden className="size-3.5" /> {t("offline")}
      </p>
    );
  }
  if (ack === undefined) {
    return (
      <p className={tone.dim} data-testid={`${testPrefix}-${tab}`} data-state="unknown">
        <CircleDashed aria-hidden className="size-3.5" /> {t("unknown")}
      </p>
    );
  }
  if (ack.state === "loaded" && ack.loadedAt) {
    const time = format.dateTime(new Date(ack.loadedAt), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
    return (
      <p className={tone.ok} data-testid={`${testPrefix}-${tab}`} data-state="loaded">
        <CheckCircle2 aria-hidden className="size-3.5" /> {t("loaded", { time })}
      </p>
    );
  }
  if (ack.state === "waiting") {
    return (
      <p className={tone.wait} data-testid={`${testPrefix}-${tab}`} data-state="waiting" title={t("waitingHint")}>
        <Loader2 aria-hidden className="size-3.5 animate-spin" /> {t("waiting")}
      </p>
    );
  }
  return (
    <p className={tone.dim} data-testid={`${testPrefix}-${tab}`} data-state="unknown">
      <CircleDashed aria-hidden className="size-3.5" /> {t("unknown")}
    </p>
  );
}

const tabParser = parseAsStringLiteral(PAGE_TABS).withDefault("schedule");

/** `?tab=channels&section=<channel id>` (the registry's "edit settings" link): open that section and bring it into view. */
function revealSection(id: string): void {
  const target = document.querySelector<HTMLElement>(`[data-testid="section-${CSS.escape(id)}"]`);
  if (!target) return;
  for (let details = target.closest("details"); details; details = details.parentElement?.closest("details") ?? null) details.open = true;
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // (jsdom has no scrollIntoView)
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
}

/** notify.yaml's quiet hours as saved (the timeline hatches them); null when that file did not load. */
function savedQuietHours(sections: SettingsSection[]): QuietInput | null {
  const draft = sections.find((section) => section.tab === "notify")?.draft;
  if (!draft) return null;
  const { "quiet_hours.enabled": enabled, "quiet_hours.start": start, "quiet_hours.end": end } = draft;
  return typeof start === "string" && typeof end === "string" ? { enabled: enabled === true, start, end } : null;
}

/**
 * The /settings page body: one form per config file, and the manual actions as a tab of their own. The save Server Action
 * lives here (not in the forms) so its state survives the remount that follows every save: a form
 * is keyed by the hash of its file.
 */
export function SettingsEditor({ sections, status: initialStatus, channelChoices, providerStates, criteriaImpact = null, aiDisclosure = null, catalog = null, catalogError = null, workflow, telegram = null, timezone, now }: SettingsEditorProps) {
  const t = useTranslations("settings");
  const [tab, setTab] = useQueryState("tab", tabParser);
  const [section] = useQueryState("section", parseAsString);
  useEffect(() => {
    if (section !== null && tab === "channels") revealSection(section);
  }, [section, tab]);
  const [state, save, pending] = useActionState(saveSettingsAction, IDLE_SETTINGS_STATE);
  const { status, refresh } = useControlStatus(initialStatus);

  useEffect(() => {
    if (state.status === "saved") toastTone("success", t("actions.savedToast"), { id: `settings-${state.nonce}` });
  }, [state, t]);
  // A save changes the file on disk: ask for the runner's acknowledgement right away and keep asking.
  const savedNonce = state.status === "saved" ? state.nonce : 0;
  useEffect(() => {
    if (savedNonce !== 0) refresh();
  }, [savedNonce, refresh]);

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onValueChange={(next) => void setTab(next as PageTab)} className="gap-4">
        <TabsList variant="segmented" aria-label={t("tabs.label")}>
          {CONFIG_PAGE_TABS.map((name) => (
            <TabsTrigger key={name} value={name} className="flex-none" data-testid={`tab-${name}`}>
              {t(`tabs.${name}`)}
            </TabsTrigger>
          ))}
          <span aria-hidden="true" className="bg-ink mx-1 w-[3px] shrink-0 self-stretch" />
          <TabsTrigger value={ACTIONS_TAB} className="flex-none" data-testid={`tab-${ACTIONS_TAB}`}>
            {t(`tabs.${ACTIONS_TAB}`)}
          </TabsTrigger>
          <TabsTrigger value={ADVANCED_TAB} className="flex-none" data-testid={`tab-${ADVANCED_TAB}`}>
            {t(`tabs.${ADVANCED_TAB}`)}
          </TabsTrigger>
        </TabsList>
        {CONFIG_PAGE_TABS.map((pageTab) => (
          // Every panel stays mounted (just hidden) so unsaved edits survive a tab switch.
          <TabsContent key={pageTab} value={pageTab} forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
            {pageTab === "channels" ? (
              <p className="text-body-sm" data-testid="registry-link">
                <Link href="/sources/registry" className="font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink">
                  {t("registryLink")}
                </Link>
              </p>
            ) : null}
            {pageTab === "notify" && telegram !== null ? <TelegramStatus status={telegram} testDisabled={status === null} /> : null}
            {pageTab === "notify" ? (
              <p className="text-body-sm" data-testid="reminder-link">
                <button type="button" onClick={() => void setTab("workflow")} className="font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink">
                  {t("notifyReminderLink")}
                </button>
              </p>
            ) : null}
            {pageTab === "workflow" ? <WorkflowPanel view={workflow} ack={<AckLine tab="notify" status={status} timezone={timezone} />} repairHref={repairHref} /> : null}
            {TAB_LAYOUT[pageTab].map((form) => {
              const section = sections.find((candidate) => candidate.tab === form);
              if (!section) return null;
              return section.draft ? (
                <ConfigForm
                  key={`${section.tab}-${section.hash}`}
                  tab={section.tab}
                  section={section}
                  file={section.file ?? SETTINGS_FILES[section.tab]}
                  state={state}
                  pending={pending}
                  ack={<AckLine tab={section.tab} status={status} timezone={timezone} />}
                  {...(section.tab === "ai" && providerStates ? { providerStates } : {})}
                  {...(section.tab === "ai" ? { catalog, catalogError, criteriaImpact, aiDisclosure } : {})}
                  {...(section.tab === "schedule" ? { timeline: { quiet: savedQuietHours(sections), timeZone: timezone, now } } : {})}
                  onSave={(draft) => {
                    const request: SaveSettingsRequest = { tab: section.tab, draft, baseHash: section.hash };
                    save(request);
                  }}
                />
              ) : (
                <LoadError key={section.tab} file={section.file ?? SETTINGS_FILES[section.tab]} repair={SETTINGS_FILES[section.tab]} message={section.loadError ?? ""} />
              );
            })}
          </TabsContent>
        ))}
        <TabsContent value={ACTIONS_TAB} className="flex flex-col gap-6">
          <ActionsPanel status={status} onRequested={refresh} channelChoices={channelChoices} timezone={timezone} />
          <SetupWizardCard />
        </TabsContent>
        <TabsContent value={ADVANCED_TAB}>{tab === ADVANCED_TAB ? <AdvancedPanel ackFor={(stem) => <AckLine tab={stem} status={status} timezone={timezone} testPrefix="advanced-ack" surface="paper" />} onChanged={refresh} /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
