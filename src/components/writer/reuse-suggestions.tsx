"use client";

import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { findSimilarAnswersAction, type SimilarAnswer } from "@/app/jobs/[id]/apply/actions";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/actions/client";
import { questionTokens } from "@/lib/writer/similar";

/** The pause after the last keystroke before the earlier answers are looked up. */
const LOOKUP_DELAY_MS = 500;

/**
 * Earlier final answers to questions that read like the one being typed (other jobs only), each with a button that starts
 * the new question from that answer. It reads this database and calls no AI provider. Nothing shows while the text has
 * fewer than `minWords` words or nothing is similar enough.
 */
export function ReuseSuggestions({ jobId, text, minWords, enabled, disabled, onUse }: { jobId: number; text: string; /** Fewest words (`reuse.min_question_words`) before anything is looked up. */ minWords: number; enabled: boolean; disabled: boolean; onUse: (match: SimilarAnswer) => void }) {
  const t = useTranslations("writer.reuse");
  const [found, setFound] = useState<{ text: string; matches: SimilarAnswer[] } | null>(null);

  useEffect(() => {
    const trimmed = text.trim();
    if (!enabled || questionTokens(trimmed).size < minWords) return;
    let current = true;
    const timer = setTimeout(() => {
      void callAction(() => findSimilarAnswersAction({ jobId, text: trimmed }), () => null).then((result) => {
        if (current && result?.ok) setFound({ text: trimmed, matches: result.matches });
      });
    }, LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [jobId, text, enabled, minWords]);

  // matches of an older text stay hidden while the text has changed (the next lookup replaces them)
  const matches = found !== null && found.text === text.trim() ? found.matches : [];
  if (matches.length === 0) return null;
  return (
    <div className="bg-soft rounded-card flex flex-col gap-2 px-3 py-2.5" role="region" aria-label={t("label")} data-testid="writer-reuse">
      <p className="text-body-sm font-semibold">{t("title")}</p>
      <ul className="flex flex-col gap-2">
        {matches.map((match) => (
          <li key={match.versionId} className="flex min-w-0 flex-col gap-1" data-testid="writer-reuse-match" data-version-id={match.versionId}>
            <span className="text-body-sm line-clamp-2 [overflow-wrap:anywhere]">“{match.question}”</span>
            <span className="text-ink-3 text-data font-mono [overflow-wrap:anywhere]">
              {t("from", { company: match.company, title: match.jobTitle, percent: match.percent })}
            </span>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onUse(match)} disabled={disabled} data-testid="writer-reuse-use">
                <History aria-hidden /> {t("use")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-ink-3 text-body-sm">{t("note")}</p>
    </div>
  );
}
