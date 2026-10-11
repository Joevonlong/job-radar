"use client";

import { FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { CategoryPreview as PreviewResult } from "@/lib/interests/preview";

interface CategoryPreviewProps {
  /** Id of the category (test ids). */
  categoryId: string;
  /** The row's draft path (`categories.<index>`): its own errors are named, others are summarised. */
  at: string;
  /** Runs the preview with the whole form as it is now. */
  run: () => Promise<PreviewResult>;
}

/**
 * "Try on recent jobs" of one category: its words and patterns over the newest open jobs (no AI, nothing saved),
 * the number of jobs hit, up to three quoted examples, and what a save would cost in AI reviews.
 */
export function CategoryPreview({ categoryId, at, run }: CategoryPreviewProps) {
  const t = useTranslations("interests");
  const tp = useTranslations("interests.preview");
  const [result, setResult] = useState<PreviewResult | "failed" | null>(null);
  const [pending, startTransition] = useTransition();

  function invalidText(fieldErrors: Extract<PreviewResult, { status: "invalid" }>["fieldErrors"]): string {
    const own = fieldErrors.find((error) => error.path === at || error.path.startsWith(`${at}.`));
    return own ? tp("invalid", { error: t(`errors.${own.key}`, own.params) }) : tp("invalidOther");
  }

  function start() {
    startTransition(async () => {
      try {
        setResult(await run());
      } catch {
        setResult("failed");
      }
    });
  }

  return (
    <div className="border-grid flex flex-col gap-2 rounded-tag border-bw border-dashed px-3 py-2.5" data-testid={`category-preview-${categoryId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={start} data-testid={`category-preview-run-${categoryId}`}>
          <FlaskConical aria-hidden /> {pending ? tp("running") : tp("button")}
        </Button>
        <p className="text-ink-2 text-body-sm">{tp("hint")}</p>
      </div>
      <div aria-live="polite">{result === null || pending ? null : <Outcome result={result} invalidText={result !== "failed" && result.status === "invalid" ? invalidText(result.fieldErrors) : ""} categoryId={categoryId} />}</div>
    </div>
  );
}

function Outcome({ result, invalidText, categoryId }: { result: PreviewResult | "failed"; invalidText: string; categoryId: string }) {
  const tp = useTranslations("interests.preview");
  const testId = `category-preview-result-${categoryId}`;
  if (result === "failed" || result.status === "invalidPayload") {
    return (
      <p role="alert" className="text-bad text-body-sm font-bold" data-testid={testId} data-status="failed">
        {tp("failed")}
      </p>
    );
  }
  if (result.status === "unavailable") {
    return (
      <p className="text-ink-2 text-body-sm" data-testid={testId} data-status="unavailable">
        {tp("unavailable")}
      </p>
    );
  }
  if (result.status === "invalid") {
    return (
      <p role="alert" className="text-bad text-body-sm font-bold" data-testid={testId} data-status="invalid">
        {invalidText}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-body-sm" data-testid={testId} data-status="ok" data-hits={result.hits} data-scanned={result.scanned} data-truncated={result.truncated ? "true" : "false"}>
      <p className="font-bold">{result.scanned === 0 && !result.truncated ? tp("noJobs") : tp("result", { hits: result.hits, scanned: result.scanned })}</p>
      {result.truncated ? (
        <p className="text-warning-text font-bold" data-testid={`category-preview-truncated-${categoryId}`}>
          {tp("truncated", { scanned: result.scanned })}
        </p>
      ) : null}
      {result.samples.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-ink-2 text-label font-bold">{tp("samplesHeading")}</p>
          <ul className="flex flex-col gap-1.5">
            {result.samples.map((sample) => (
              <li key={sample.jobId} className="flex min-w-0 flex-col gap-0.5">
                <a href={`/jobs/${sample.jobId}`} className="text-ink truncate font-bold underline-offset-2 hover:underline">
                  {sample.title}
                </a>
                <q className="text-ink-2 break-words">{sample.quote}</q>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-ink-2" data-testid={`category-preview-review-${categoryId}`}>
        {result.review === null ? tp("noReview") : tp("reviewEstimate", { jobs: result.review.jobs, rounds: result.review.rounds === null || result.review.jobs === 0 ? "none" : String(result.review.rounds) })}
      </p>
    </div>
  );
}
