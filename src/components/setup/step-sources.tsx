"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field, describedBy } from "@/components/profile/fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DocLink } from "@/components/ui/doc-link";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { REGISTRY_GROUPS } from "@/lib/sources/registry/groups";
import type { BoardInput } from "@/lib/setup/inputs";
import type { SetupView } from "@/lib/setup/view";

import { EnvPresenceList } from "./env-presence";
import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

interface StepSourcesProps {
  view: SetupView["sources"];
  /** Saved before: the switches as they are; else the market's own channels are pre-selected too. */
  done: boolean;
}

/** Step 5: channels of the market (switches; keys as names + set / not set) and company career boards to add. */
export function StepSources({ view, done }: StepSourcesProps) {
  const t = useTranslations("setup.sources");
  const tEnv = useTranslations("setup.env");
  const tGroup = useTranslations("sourcesRegistry.group");
  const tBoard = useTranslations("sourcesRegistry.board");
  const { pending, save, skip, errors, formError } = useStep("sources");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(view.channels.map((c) => [c.id, c.consent === null ? c.enabled || (!done && c.local) : done && c.enabled])));
  const [boards, setBoards] = useState<BoardInput[]>([]);
  const [acknowledge, setAcknowledge] = useState(false);
  const firstAts = view.atsKinds[0] ?? "";

  if (view.problem !== null) {
    return (
      <StepFrame step="sources" pending={pending} formError={formError} onSkip={skip} onSubmit={() => undefined} disabled>
        <p role="alert" className="text-body-sm font-bold text-bad">
          {t("unreadable")}
        </p>
      </StepFrame>
    );
  }

  const groups = REGISTRY_GROUPS.map((group) => ({ group, channels: view.channels.filter((c) => c.group === group) })).filter((g) => g.channels.length > 0);
  const anyMissing = view.channels.some((c) => c.env.some((e) => !e.present));
  // the acknowledgement is asked for as soon as a channel with a terms-of-service notice is ticked
  const anyConsent = view.channels.some((c) => c.consent !== null && (enabled[c.id] ?? false));

  return (
    <StepFrame step="sources" pending={pending} formError={formError} onSkip={skip} onSubmit={() => save({ channels: enabled, boards, acknowledge })}>
      <p className="text-body-sm text-ink-2">
        {t("intro")} {view.channels.some((c) => c.local) ? t("localHint") : null}
      </p>
      {groups.length === 0 ? <p className="text-body-sm">{t("none")}</p> : null}
      {groups.map(({ group, channels }) => (
        <fieldset key={group} className="flex flex-col gap-sp-2" data-testid={`setup-sources-group-${group}`}>
          <legend className="mb-1 font-mono text-data-sm font-semibold tracking-wider text-ink-2 uppercase">{tGroup(group)}</legend>
          <ul className="flex flex-col divide-y-[1.5px] divide-grid rounded-card border-bw border-border bg-card">
            {channels.map((channel) => {
              const id = `setup-channel-${channel.id.replace(/[^a-z0-9-]/gi, "-")}`;
              const error = errors.text(`channels.${channel.id}`);
              return (
                <li key={channel.id} className="flex flex-col gap-1 px-sp-3 py-sp-2">
                  <div className="flex flex-wrap items-center gap-sp-2">
                    <Checkbox
                      id={id}
                      checked={enabled[channel.id] ?? false}
                      aria-label={t("toggle", { name: channel.id })}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${id}-msg` : undefined}
                      onCheckedChange={(checked) => setEnabled({ ...enabled, [channel.id]: checked === true })}
                      data-testid="setup-channel"
                      data-channel={channel.id}
                    />
                    <label htmlFor={id} className="cursor-pointer font-mono text-data font-semibold">
                      {channel.id}
                    </label>
                    {channel.local ? <Badge variant="tag">{t("local")}</Badge> : null}
                    {channel.consent !== null ? <Badge variant="outline">{t("consent.badge")}</Badge> : null}
                    {channel.env.length > 0 ? <span className="ml-auto font-mono text-data-sm text-ink-3">{t("needsKey")}</span> : null}
                  </div>
                  {channel.env.length > 0 ? <EnvPresenceList env={channel.env} className="pl-7" /> : null}
                  {channel.consent !== null ? (
                    <p className="pl-7 text-body-sm text-ink-2" data-testid="setup-channel-consent" data-channel={channel.id}>
                      {t(`consent.${channel.consent}`)}
                    </p>
                  ) : null}
                  {error ? (
                    <p id={`${id}-msg`} role="alert" className="text-body-sm font-bold text-bad">
                      {error}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
      {anyMissing ? <p className="text-body-sm text-ink-2">{tEnv("restart")}</p> : null}
      {anyConsent ? (
        <div className="flex flex-col gap-1" data-testid="setup-consent">
          <div className="flex items-start gap-sp-2">
            <Checkbox
              id="setup-consent-ack"
              checked={acknowledge}
              aria-invalid={errors.has("acknowledge") || undefined}
              aria-describedby={errors.has("acknowledge") ? "setup-consent-ack-msg" : undefined}
              onCheckedChange={(checked) => setAcknowledge(checked === true)}
              data-testid="setup-consent-ack"
            />
            <label htmlFor="setup-consent-ack" className="cursor-pointer text-body-sm font-bold">
              {t("consent.confirm")}
            </label>
          </div>
          <p className="pl-7 text-body-sm text-ink-2" data-testid="setup-consent-docs">
            {t.rich("consent.docs", { docs: (chunks) => <DocLink doc="scraping">{chunks}</DocLink> })}
          </p>
          {errors.text("acknowledge") ? (
            <p id="setup-consent-ack-msg" role="alert" className="text-body-sm font-bold text-bad">
              {errors.text("acknowledge")}
            </p>
          ) : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-sp-3" aria-labelledby="setup-boards-title" data-testid="setup-boards">
        <div className="flex flex-col gap-1">
          <h3 id="setup-boards-title" className="text-label font-bold">
            {t("boards")}
          </h3>
          <p className="text-body-sm text-ink-2">{t("boardsHint")}</p>
          <p className="font-mono text-data text-ink-2">{t("existingBoards", { count: view.boards.length })}</p>
        </div>
        {boards.map((board, index) => {
          const rowIds = { name: `setup-board-${index}-name`, ats: `setup-board-${index}-ats`, token: `setup-board-${index}-token` };
          const update = (next: Partial<BoardInput>): void => setBoards(boards.map((b, i) => (i === index ? { ...b, ...next } : b)));
          return (
            <fieldset key={index} className="grid gap-sp-3 rounded-card border-bw border-dashed border-border p-sp-3 sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-start" data-testid="setup-board-row">
              <legend className="sr-only">{t("boardRow", { index: index + 1 })}</legend>
              <Field id={rowIds.name} label={tBoard("name")} errorText={errors.text(`boards.${index}.name`)}>
                <Input id={rowIds.name} autoComplete="off" value={board.name} aria-invalid={errors.has(`boards.${index}.name`) || undefined} aria-describedby={describedBy(rowIds.name, false, errors.text(`boards.${index}.name`))} onChange={(event) => update({ name: event.target.value })} />
              </Field>
              <Field id={rowIds.ats} label={tBoard("ats")} errorText={errors.text(`boards.${index}.ats`)}>
                <Select id={rowIds.ats} value={board.ats} aria-invalid={errors.has(`boards.${index}.ats`) || undefined} onChange={(event) => update({ ats: event.target.value })}>
                  {view.atsKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={rowIds.token} label={tBoard("token")} hint={tBoard("tokenHint")} errorText={errors.text(`boards.${index}.token`)}>
                <Input id={rowIds.token} className="font-mono" autoComplete="off" value={board.token} aria-invalid={errors.has(`boards.${index}.token`) || undefined} aria-describedby={describedBy(rowIds.token, true, errors.text(`boards.${index}.token`))} onChange={(event) => update({ token: event.target.value })} />
              </Field>
              <Button type="button" variant="ghost" size="icon" className="sm:mt-7" aria-label={t("removeBoard", { index: index + 1 })} onClick={() => setBoards(boards.filter((_, i) => i !== index))}>
                <Trash2 aria-hidden />
              </Button>
            </fieldset>
          );
        })}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setBoards([...boards, { name: "", ats: firstAts, token: "" }])} data-testid="setup-add-board">
          <Plus aria-hidden />
          {t("addBoard")}
        </Button>
      </section>
    </StepFrame>
  );
}
