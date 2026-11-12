"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";

import { saveAgentMatrixAction } from "@/app/settings/agents/actions";
import { SaveBar } from "@/components/settings/save-bar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { MATRIX_ROWS, PERMISSION_NOTES, PRESET_IDS, narrowingImpact, normalizePermissions, presetOf, presetSelection, type MatrixRow, type PresetId } from "@/lib/agent-access/matrix";
import type { Permission } from "@/lib/agent-access/permissions";

import { useReportResult } from "./use-report-result";

type Access = "read" | "write" | "run";

interface CellProps {
  permission: Permission | null;
  access: Access;
  area: string;
  colSpan?: number;
  checked: boolean;
  disabled: boolean;
  tools: readonly string[];
  onChange: (permission: Permission, on: boolean) => void;
}

/** One permission: a 44px tick target, and under it the tools it gives (from the capability registry), opened on demand. */
function Cell({ permission, access, area, colSpan, checked, disabled, tools, onChange }: CellProps) {
  const t = useTranslations("agents.matrix");
  if (permission === null) {
    return (
      <td className="px-1 py-2 text-center align-top text-ink-3">
        <span aria-hidden>—</span>
        <span className="sr-only">{t("missing")}</span>
      </td>
    );
  }
  return (
    <td colSpan={colSpan} className="px-1 py-1 align-top">
      <div className="flex flex-col items-center gap-0.5">
        <label className="grid min-h-11 min-w-11 cursor-pointer place-items-center has-[:disabled]:cursor-not-allowed">
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={(value) => onChange(permission, value === true)}
            aria-label={t("cell", { area, access: t(`access.${access}`) })}
            data-testid={`matrix-${permission}`}
            className="disabled:border-dotted"
          />
        </label>
        {tools.length === 0 ? (
          <span className="font-mono text-data-sm text-ink-3">{t("tools", { count: 0 })}</span>
        ) : (
          <details className="w-full max-w-40 text-center" data-testid={`matrix-tools-${permission}`}>
            <summary className="cursor-pointer font-mono text-data-sm text-ink-3 underline decoration-dotted underline-offset-2">{t("tools", { count: tools.length })}</summary>
            <ul className="mt-1 flex flex-col gap-0.5 text-left font-mono text-data-sm text-ink-2 [overflow-wrap:anywhere]">
              {tools.map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </td>
  );
}

/** The name, what the area covers (two lines at most on a phone) and what its permissions need the owner to know. */
function RowHeader({ row }: { row: MatrixRow }) {
  const t = useTranslations("agents.matrix");
  const permissions = row.kind === "area" ? [row.read, row.write] : [row.permission];
  const notes = permissions.flatMap((permission) => {
    const note = permission === null ? undefined : PERMISSION_NOTES[permission];
    return note === undefined || permission === null ? [] : [{ permission, note }];
  });
  return (
    <th scope="row" className="py-2 pr-2 text-left align-top font-normal">
      <span className="block font-bold">{t(`areas.${row.id}.name`)}</span>
      <span className="line-clamp-2 text-body-sm text-ink-3 sm:line-clamp-none">{t(`areas.${row.id}.includes`)}</span>
      {notes.length > 0 ? (
        <span className="mt-1 flex flex-wrap gap-1">
          {notes.map(({ permission, note }) => (
            <Badge key={permission} variant="gate-note" className="text-left whitespace-normal" data-testid={`matrix-note-${permission}`}>
              {t(`notes.${note}`)}
            </Badge>
          ))}
        </span>
      ) : null}
    </th>
  );
}

function changedCount(saved: readonly Permission[], selection: readonly Permission[]): number {
  const before = new Set(saved);
  const after = new Set(selection);
  return [...before].filter((permission) => !after.has(permission)).length + [...after].filter((permission) => !before.has(permission)).length;
}

/**
 * The global matrix: the most any connection gets. Presets only change the ticks; the save bar saves them against the fingerprint
 * the page was read with, and says beforehand what narrowing takes from the connections that have it now. The parent remounts it
 * after each save (keyed by the fingerprint), so it always starts from the file.
 */
export function MatrixCard({ saved, baseHash, locked, tools, grants }: { saved: Permission[]; baseHash: string | null; locked: boolean; tools: Record<Permission, string[]>; grants: readonly (readonly Permission[])[] }) {
  const t = useTranslations("agents.matrix");
  const report = useReportResult();
  const [selection, setSelection] = useState<Permission[]>(saved);
  const [pending, startTransition] = useTransition();
  const disabled = locked || baseHash === null;
  const chosen = new Set(selection);
  const impact = narrowingImpact(saved, selection, grants);

  function change(permission: Permission, on: boolean) {
    setSelection((current) => normalizePermissions(on ? [...current, permission] : current.filter((item) => item !== permission)));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || baseHash === null) return;
    startTransition(async () => {
      report(await saveAgentMatrixAction({ permissions: selection, baseHash }));
    });
  }

  const cell = (row: MatrixRow, permission: Permission | null, access: Access, colSpan?: number) => (
    <Cell permission={permission} access={access} area={t(`areas.${row.id}.name`)} colSpan={colSpan} checked={permission !== null && chosen.has(permission)} disabled={disabled || pending} tools={permission === null ? [] : tools[permission]} onChange={change} />
  );

  return (
    <Card data-testid="agents-matrix-card">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <form onSubmit={submit} className="flex flex-col pb-4">
        <CardContent className="gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label font-bold text-ink-2">{t("presetsLabel")}</span>
            <Segmented aria-label={t("presetsLabel")} value={presetOf(selection) ?? ""} onValueChange={(id) => setSelection(presetSelection(id as PresetId))} disabled={disabled || pending} data-testid="matrix-presets">
              {PRESET_IDS.map((id) => (
                <SegmentedItem key={id} value={id} data-testid={`matrix-preset-${id}`}>
                  {t(`presets.${id}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>
          <table className="w-full table-fixed border-collapse text-body-sm" data-testid="agents-matrix">
            <caption className="sr-only">{t("title")}</caption>
            <colgroup>
              <col />
              <col className="w-[4.75rem] sm:w-32" />
              <col className="w-[4.75rem] sm:w-32" />
            </colgroup>
            <thead>
              <tr className="border-b-bw border-border text-label font-bold text-ink-2">
                <th scope="col" className="py-2 pr-2 text-left">
                  {t("columns.area")}
                </th>
                <th scope="col" className="px-1 py-2 text-center">
                  {t("columns.read")}
                </th>
                <th scope="col" className="px-1 py-2 text-center">
                  {t("columns.write")}
                </th>
              </tr>
            </thead>
            <tbody>
              {MATRIX_ROWS.map((row) => (
                <tr key={row.id} className="border-b-[1.5px] border-grid last:border-b-0" data-row={row.id}>
                  <RowHeader row={row} />
                  {row.kind === "area" ? (
                    <>
                      {cell(row, row.read, "read")}
                      {cell(row, row.write, "write")}
                    </>
                  ) : (
                    cell(row, row.permission, "run", 2)
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
        <SaveBar
          labels={{ dirty: (count) => t("bar.dirty", { count }), clean: t("bar.clean"), save: t("bar.save"), saving: t("bar.saving"), revert: t("bar.revert") }}
          dirtyCount={changedCount(saved, selection)}
          pending={pending}
          blocked={disabled}
          onRevert={() => setSelection(saved)}
          status={impact.connections > 0 ? <span className="text-term-amber" data-testid="matrix-impact">{t("impact", { connections: impact.connections, permissions: impact.permissions })}</span> : null}
          floating
          saveTestId="matrix-save"
        />
      </form>
    </Card>
  );
}
