"use client";

import { useTranslations } from "next-intl";
import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { loadAdvancedFileAction as rawLoadAdvancedFileAction, loadAdvancedIndexAction as rawLoadAdvancedIndexAction } from "@/app/settings/actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AdvancedFileData, AdvancedFileEntry, AdvancedLoad } from "@/lib/settings/advanced/types";

import { FileEditor } from "./file-editor";
import { FileList } from "./file-list";
import { withActionFeedback } from "@/lib/actions/client";

const loadAdvancedFileAction = withActionFeedback(rawLoadAdvancedFileAction)(() => ({ ok: false, reason: "unreadable" }));
const loadAdvancedIndexAction = withActionFeedback(rawLoadAdvancedIndexAction)(() => ([]));

interface AdvancedPanelProps {
  /** The runner's "loaded hh:mm" line for a file (by its `?file=` name); null = none. */
  ackFor: (stem: string) => ReactNode;
  /** Called after a save / restore (the page asks the runner status again). */
  onChanged: () => void;
}

/**
 * The advanced tab: every config file as raw text. The list and the text are read through Server Actions when the tab
 * is shown (no config has to be readable for this tab to work: it is where a broken file gets repaired). `?file=<name>` picks the file.
 */
export function AdvancedPanel({ ackFor, onChanged }: AdvancedPanelProps) {
  const t = useTranslations("settings.advanced");
  const [fileParam, setFileParam] = useQueryState("file", parseAsString);
  const [entries, setEntries] = useState<AdvancedFileEntry[] | null>(null);
  const [loaded, setLoaded] = useState<{ stem: string; result: AdvancedLoad } | null>(null);

  const refreshIndex = useCallback(() => {
    void loadAdvancedIndexAction().then(setEntries);
  }, []);
  useEffect(() => refreshIndex(), [refreshIndex]);

  // the file that is open: the one in the URL, else the first file with a problem, else the first one
  const stem = fileParam ?? entries?.find((entry) => !entry.valid)?.stem ?? entries?.[0]?.stem ?? null;
  const known = stem !== null && (entries === null || entries.some((entry) => entry.stem === stem || entry.stem === stem.replace(/^channels$/, "sources")));

  useEffect(() => {
    if (stem === null || !known) return;
    let cancelled = false;
    void loadAdvancedFileAction(stem).then((result) => {
      if (!cancelled) setLoaded({ stem, result });
    });
    return () => {
      cancelled = true;
    };
  }, [stem, known]);

  const select = (next: string) => {
    if (next === stem) return;
    void setFileParam(next);
  };

  const current = loaded !== null && loaded.stem === stem ? loaded.result : null;
  const data: AdvancedFileData | null = current?.ok ? current.data : null;

  return (
    <Card className="gap-4 py-4" data-testid="advanced-card">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 px-4 md:grid-cols-[15rem_minmax(0,1fr)] md:px-5">
        {entries === null ? (
          <p className="text-ink-2" role="status">
            {t("loading")}
          </p>
        ) : (
          <FileList entries={entries} selected={data?.entry.stem ?? stem} onSelect={select} />
        )}
        <div className="min-w-0">
          {!known ? (
            <p role="alert" className="text-bad font-bold" data-testid="advanced-unknown-file">
              {t("unknownFile")}
            </p>
          ) : current !== null && !current.ok ? (
            <p role="alert" className="text-bad font-bold" data-testid="advanced-unreadable">
              {t(current.reason === "unreadable" ? "unreadable" : "unknownFile")}
            </p>
          ) : data ? (
            <FileEditor
              // another file starts a fresh editor; a save keeps the state it has
              key={data.entry.stem}
              data={data}
              ack={ackFor(data.entry.stem)}
              onChanged={() => {
                refreshIndex();
                onChanged();
              }}
            />
          ) : (
            <p className="text-ink-2" role="status">
              {t("loading")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
