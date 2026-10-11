"use client";

import { ExternalLink, Loader2, Plus, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";
import { useState, useTransition } from "react";

import { addBoardCandidateAction, dismissBoardCandidateAction } from "@/app/sources/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CandidateActionState, CandidateView } from "@/lib/sources/candidates";
import { filterCandidates } from "@/lib/sources/registry/filter";
import { REGISTRY_QUERY_MAX, registryParsers } from "@/lib/sources/registry/params";

import { formatWhen } from "./format";

type Feedback = { tone: "ok" | "error"; text: string } | null;

/** Boards that discovery found and `ats_boards` does not list yet: add one (writes sources.yaml) or dismiss it (shown on /sources/registry). `candidates` is null when the list cannot be read. */
export function CandidatesCard({ candidates, timeZone, readOnlyHint = null, pageSize = 10 }: { candidates: CandidateView[] | null; timeZone: string; readOnlyHint?: string | null; pageSize?: number }) {
  const t = useTranslations("sources.discovery");
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [params] = useQueryStates(registryParsers, { history: "replace" });
  const [pages, setPages] = useState(1);
  // The search text, the ATS and the type of the registry filters apply here; a status has no meaning for a board that is not listed yet.
  const all = candidates ?? [];
  const matching = filterCandidates(all, { type: params.type, ats: params.ats, q: params.q.slice(0, REGISTRY_QUERY_MAX) });
  const filtered = params.type !== "all" || params.ats !== null || params.q !== "";
  const visible = matching.slice(0, pages * pageSize);
  const hidden = matching.length - visible.length;

  const run = (candidate: CandidateView, action: typeof addBoardCandidateAction) => {
    setBusy(`${candidate.ats}:${candidate.token}`);
    startTransition(async () => {
      const result: CandidateActionState = await action({ ats: candidate.ats, token: candidate.token });
      if (result.status === "error") {
        setFeedback({ tone: "error", text: t(`error.${result.error}`) });
      } else if (result.outcome === "added") {
        setFeedback({ tone: "ok", text: t("added", { name: candidate.name }) });
      } else if (result.outcome === "already_listed") {
        setFeedback({ tone: "ok", text: t("alreadyListed", { name: candidate.name }) });
      } else {
        setFeedback({ tone: "ok", text: t("dismissed", { name: candidate.name }) });
      }
      setBusy(null);
    });
  };

  return (
    <Card id="discovered" className="gap-0 py-0" data-testid="candidates-card">
      <CardHeader className="px-4 py-3">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
        {candidates !== null && candidates.length > 0 ? (
          <p className="text-ink-2 font-mono text-data" data-testid="candidates-count" data-total={all.length} data-matching={matching.length}>
            {filtered ? t("countFiltered", { shown: matching.length, total: all.length }) : t("count", { total: all.length })}
            {params.status.length > 0 ? ` · ${t("statusNotApplied")}` : ""}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {feedback ? (
          <p role="status" className={feedback.tone === "ok" ? "text-success-text text-body-sm" : "text-destructive text-body-sm"} data-testid="candidate-feedback">
            {feedback.text}
          </p>
        ) : null}
        {candidates === null ? (
          <p role="alert" className="text-destructive text-body-sm" data-testid="candidates-unavailable">
            {t("unavailable")}
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-ink-2 text-body-sm" data-testid="candidates-empty">
            {t("empty")}
          </p>
        ) : matching.length === 0 ? (
          <p className="text-ink-2 text-body-sm" data-testid="candidates-no-match">
            {t("noMatch")}
          </p>
        ) : (
          <ul className="flex flex-col" data-testid="candidate-list">
            {visible.map((candidate) => {
              const key = `${candidate.ats}:${candidate.token}`;
              const rowBusy = pending && busy === key;
              return (
                <li key={key} className="border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t py-2 first:border-t-0" data-testid="candidate" data-ats={candidate.ats} data-token={candidate.token}>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-body-sm font-medium">{candidate.name}</span>
                      <Badge variant="outline" className="font-mono font-normal">
                        {candidate.ats}
                      </Badge>
                      {candidate.region === "eu" ? (
                        <Badge variant="outline" className="font-normal">
                          {t("region")}
                        </Badge>
                      ) : null}
                      <a href={candidate.boardUrl} target="_blank" rel="noopener noreferrer" className="text-ink inline-flex items-center gap-1 text-data underline-offset-4 hover:underline">
                        {t("open")}
                        <ExternalLink aria-hidden className="size-3" />
                      </a>
                    </div>
                    {candidate.title ? <p className="text-ink-2 truncate text-data">{candidate.title}</p> : null}
                    <p className="text-ink-2 text-data">{t("seen", { count: candidate.seenCount, when: formatWhen(format, candidate.lastSeenAt, timeZone) })}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" size="sm" disabled={pending || readOnlyHint !== null} title={readOnlyHint ?? undefined} onClick={() => run(candidate, addBoardCandidateAction)} data-testid="candidate-add">
                      {rowBusy ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
                      {t("add")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(candidate, dismissBoardCandidateAction)} data-testid="candidate-dismiss">
                      <X aria-hidden />
                      {t("dismiss")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 ? (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => setPages((n) => n + 1)} data-testid="candidates-more">
              {t("more", { count: Math.min(hidden, pageSize), hidden })}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
