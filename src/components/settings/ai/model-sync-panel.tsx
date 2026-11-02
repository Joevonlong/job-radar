"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { addSyncedModelsAction as rawAddSyncedModelsAction, modelsSyncAction as rawModelsSyncAction } from "@/app/control-actions";
import { QueueHint } from "@/components/control/queue-hint";
import { readRequestView } from "@/components/control/read-request-view";
import { useControlRequest } from "@/components/control/use-control-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { SyncRow } from "@/lib/ai/model-sync/types";
import { withActionFeedback } from "@/lib/actions/client";
import { isOpenRequest, type ControlRequestView } from "@/lib/control/request-view-schema";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import type { AddSyncedModelsState } from "@/lib/control/models-sync-add";

type SyncActionState = ControlActionState | { status: "error"; error: "transportFailed"; nonce: number };
type AddState = AddSyncedModelsState | { status: "error"; error: "transportFailed"; nonce: number } | { status: "idle" };

const modelsSyncAction = withActionFeedback<[unknown], SyncActionState>(rawModelsSyncAction)(() => ({ status: "error", error: "transportFailed", nonce: Date.now() }));
const addSyncedModelsAction = withActionFeedback<[unknown], AddState>(rawAddSyncedModelsAction)(() => ({ status: "error", error: "transportFailed", nonce: Date.now() }));

/** Rows the page shows at once before "show more" (the table is long: an unfiltered list is hundreds of models). */
const PAGE_ROWS = 40;

interface Finished {
  id: number;
  view: ControlRequestView | null;
}

/**
 * "Refresh available models" of a multi-model provider: the ai-worker asks the provider for its model list (a `models_sync` request),
 * the result is a read-only table next to the current catalog, and the ticked models that the provider says take JSON mode are added
 * to the user's own models.yaml. Nothing refreshes by itself: the list is only read when this button is clicked.
 */
export function ModelSyncPanel({ provider, file, timeZone }: { provider: string; file: string; timeZone?: string | undefined }) {
  const t = useTranslations("settings.modelSync");
  const tTrigger = useTranslations("trigger");
  const format = useFormatter();
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<SyncActionState>(IDLE_CONTROL_STATE);
  const [pending, startTransition] = useTransition();
  const [finished, setFinished] = useState<Finished | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE_ROWS);
  const [add, setAdd] = useState<AddState>({ status: "idle" });
  const [adding, startAdding] = useTransition();
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  const queuedId = state.status === "queued" ? state.request : null;
  const ended = finished !== null && finished.id === queuedId ? finished : null;
  const wait = useControlRequest({
    requestId: ended ? null : queuedId,
    read: readRequestView,
    onDone: (view) => setFinished({ id: view.id, view }),
    onFailed: (view) => {
      if (queuedId !== null) setFinished({ id: queuedId, view });
    },
  });
  const view = ended ? ended.view : wait.waiting;
  const open = queuedId !== null && ended === null && (view === null || isOpenRequest(view));
  const sync = ended?.view?.status === "done" ? ended.view.result.sync : undefined;

  const request = () => {
    setPicked(new Set());
    setAdded(new Set());
    setAdd({ status: "idle" });
    setShown(PAGE_ROWS);
    startTransition(async () => setState(await modelsSyncAction({ provider, ...(filter.trim() !== "" ? { filter: filter.trim() } : {}) })));
  };

  const rows = useMemo(() => sync?.rows ?? [], [sync]);
  const addable = useMemo(() => new Set(rows.filter((row) => row.addable && !row.inCatalog).map((row) => row.id)), [rows]);
  const number = (value: number): string => format.number(value, { maximumFractionDigits: 4 });
  const toggle = (id: string, on: boolean) => setPicked((current) => new Set(on ? [...current, id] : [...current].filter((other) => other !== id)));
  const chosen = [...picked].filter((id) => addable.has(id) && !added.has(id));

  const submit = () => {
    if (ended === null || chosen.length === 0) return;
    startAdding(async () => {
      const outcome = await addSyncedModelsAction({ requestId: ended.id, ids: chosen });
      setAdd(outcome);
      if (outcome.status === "added") {
        setAdded((current) => new Set([...current, ...outcome.added]));
        setPicked(new Set());
        router.refresh();
      }
    });
  };

  const statusOf = (row: SyncRow): { text: string; variant: "skill-hit" | "skill" | "gate-warn" | "gate-note" } => {
    if (added.has(row.id) || row.inCatalog) return { text: added.has(row.id) ? t("status.added") : t("status.inCatalog"), variant: "skill-hit" };
    if (row.addable) return { text: t("status.canAdd"), variant: "skill" };
    if (row.addableUnverified) return { text: t("status.unverified"), variant: "gate-note" };
    if (!row.textChat) return { text: t("status.notChat"), variant: "gate-warn" };
    if (row.price === null) return { text: t("status.noPrice"), variant: "gate-warn" };
    if (row.json === "no") return { text: t("status.noJson"), variant: "gate-warn" };
    return { text: t("status.retired"), variant: "gate-warn" };
  };

  const failureText = (): string | null => {
    if (state.status === "error") return state.error === "tooSoon" ? tTrigger("refused.tooSoon", { seconds: state.retryAfterSeconds ?? 1 }) : tTrigger(`refused.${state.error}`);
    if (ended !== null && (ended.view === null || ended.view.status === "failed")) return t("failed", { kind: ended.view?.result.errorKind ?? ended.view?.result.error ?? "unknown" });
    if (ended?.view?.status === "done" && !sync) return t("failed", { kind: "unreadable" });
    return null;
  };
  const failure = failureText();

  return (
    <section className="border-grid flex flex-col gap-3 border-t-[1.5px] pt-3" data-testid={`model-sync-${provider}`} data-state={pending || open ? "busy" : sync ? "done" : failure ? "failed" : "idle"} aria-label={t("title", { provider })}>
      <div className="flex flex-col gap-1">
        <h5 className="text-label font-bold">{t("title", { provider })}</h5>
        <p className="text-ink-2 text-body-sm [overflow-wrap:anywhere]">{t("hint", { provider, file })}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-body-sm">
          <span className="text-ink-2">{t("filterLabel")}</span>
          <Input value={filter} maxLength={80} onChange={(event) => setFilter(event.target.value)} placeholder={t("filterPlaceholder")} className="w-56 max-w-full" data-testid="model-sync-filter" />
        </label>
        <Button type="button" size="xs" variant="outline" disabled={pending || open} onClick={request} data-testid="model-sync-button">
          {pending || open ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden />}
          {t("refresh")}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-0.5">
          <p role="status" className="text-ink-2 text-body-sm" data-testid="model-sync-waiting">
            {state.status === "queued" && state.existing ? tTrigger("existing") : wait.stage === "running" ? t("running", { provider }) : t("pending", { provider })}
          </p>
          <QueueHint queue={wait.queue} stage={wait.stage} timeZone={timeZone} live={false} />
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="text-destructive text-body-sm" data-testid="model-sync-failure">
          {failure}
        </p>
      ) : null}
      {sync ? (
        <div className="flex flex-col gap-2" data-testid="model-sync-result">
          <p role="status" className="text-ink-2 text-body-sm">
            {t("summary", { listed: sync.listed, matched: sync.matched })}
            {sync.truncated ? ` ${t("truncated", { max: sync.rows.length })}` : ""}
          </p>
          {sync.gone.length > 0 ? (
            <p className="text-body-sm [overflow-wrap:anywhere]" data-testid="model-sync-gone">
              {t("gone", { provider, ids: sync.gone.join(", ") })}
            </p>
          ) : null}
          <div role="region" tabIndex={0} aria-label={t("tableLabel", { provider })} className="overflow-x-auto">
            <table className="w-full text-body-sm max-sm:block" aria-label={t("tableLabel", { provider })}>
              <thead className="max-sm:sr-only">
                <tr className="text-cap-style text-ink-2 bg-soft border-border border-b-bw text-left">
                  <th scope="col" className="w-8 px-2 py-1.5 font-medium"><span className="sr-only">{t("col.pick")}</span></th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.model")}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.price")}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.context")}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.json")}</th>
                  <th scope="col" className="py-1.5 pr-2 font-medium">{t("col.status")}</th>
                </tr>
              </thead>
              <tbody className="max-sm:flex max-sm:flex-col">
                {rows.slice(0, shown).map((row) => {
                  const status = statusOf(row);
                  const can = addable.has(row.id) && !added.has(row.id);
                  return (
                    <tr key={row.id} className="border-grid border-b-[1.5px] align-top last:border-b-0 max-sm:block max-sm:py-2" data-testid="model-sync-row" data-model={row.id} data-addable={can ? "1" : "0"}>
                      <td className="px-2 py-1.5 max-sm:inline-block max-sm:px-0 max-sm:py-0">
                        <Checkbox checked={picked.has(row.id)} disabled={!can} aria-label={t("pickModel", { model: row.id })} onCheckedChange={(on) => toggle(row.id, on === true)} />
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-data break-all max-sm:inline max-sm:pr-0 max-sm:font-bold">
                        {row.id}
                        {row.name !== row.id ? <span className="text-ink-2 block font-sans">{row.name}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 font-mono tabular-nums sm:whitespace-nowrap max-sm:block max-sm:pr-0">
                        {row.price ? `$${number(row.price.input_per_mtok)} / $${number(row.price.output_per_mtok)}` : "—"}
                        {row.priceWas ? <span className="text-warning-text block">{t("priceWas", { input: number(row.priceWas.input_per_mtok), output: number(row.priceWas.output_per_mtok) })}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 font-mono tabular-nums max-sm:block max-sm:pr-0">{row.contextLength === null ? "—" : format.number(row.contextLength)}</td>
                      <td className="py-1.5 pr-3 max-sm:block max-sm:pr-0">{t(`json.${row.json}`)}</td>
                      <td className="py-1.5 pr-2 max-sm:block max-sm:pr-0">
                        <span className="flex flex-wrap gap-1">
                          <Badge variant={status.variant}>{status.text}</Badge>
                          {row.expiresOn ? <Badge variant="gate-note">{t("retires", { date: row.expiresOn })}</Badge> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > shown ? (
            <Button type="button" size="xs" variant="ghost" className="w-fit" onClick={() => setShown((count) => count + PAGE_ROWS)} data-testid="model-sync-more">
              {t("showMore", { count: rows.length - shown })}
            </Button>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="xs" disabled={adding || chosen.length === 0} onClick={submit} data-testid="model-sync-add">
              {adding ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              {t("add", { count: chosen.length })}
            </Button>
            <span className="text-ink-2 text-body-sm">{t("addHint")}</span>
          </div>
          {add.status === "added" ? (
            <p role="status" className="text-success-text text-body-sm" data-testid="model-sync-added">
              {t("added", { count: add.added.length, file })}
            </p>
          ) : null}
          {add.status === "error" ? (
            <p role="alert" className="text-destructive text-body-sm" data-testid="model-sync-add-error">
              {t(`addError.${add.error}`)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
