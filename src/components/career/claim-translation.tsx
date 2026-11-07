"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { documentTexts } from "@/lib/career/document/targets";
import type { CareerDocument } from "@/lib/career/schema/document";
import { tailorAction } from "./tailor-api";

type Saved = { document: CareerDocument; baseHash: string };

/** One confirmation for every pending cross-language claim: the translated texts and the words only the JD has. */
export function TranslationConfirm({ document, baseHash, disabled, onSaved }: {
  document: CareerDocument; baseHash: string; disabled: boolean; onSaved: (saved: Saved) => void;
}) {
  const t = useTranslations("career.claims");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = document.claims.filter((claim) => claim.translation && claim.status === "pending");
  if (!pending.length) return null;
  const textIds = new Set(pending.flatMap((claim) => "text" in claim.target ? [claim.target.text] : []));
  const texts = documentTexts(document).filter((item) => textIds.has(item.value.id)).map((item) => item.value.text);
  const words = [...new Set(pending.filter((claim) => claim.in_jd).flatMap((claim) => claim.text.split(/,\s*/)))];
  async function confirm() {
    setBusy(true); setFailure(null);
    try {
      const result = await tailorAction({ action: "confirm_translation", doc_id: document.id, baseHash });
      if (!result.ok) setFailure(result.error);
      else if ("document" in result) onSaved({ document: result.document, baseHash: result.baseHash });
    } finally { setBusy(false); }
  }
  return (
    <section role="region" aria-label={t("translationTitle")} data-testid="translation-confirm" className="flex min-w-0 flex-col gap-2 rounded-card border-bw border-bad p-3">
      <p className="font-bold">{t("translationTitle")}</p>
      <p className="text-body-sm">{t("translationHint")}</p>
      <ul className="flex min-w-0 list-disc flex-col gap-1 pl-5">
        {texts.map((text, index) => <li key={index} className="break-words">{text}</li>)}
      </ul>
      {words.length > 0 && <p className="break-words text-body-sm">{t("jdOnlyWords", { words: words.join(", ") })}</p>}
      <Button variant="primary" className="w-fit" disabled={disabled || busy} onClick={() => void confirm()}>{t("confirmTranslation")}</Button>
      {failure && <p role="alert" data-code={failure}>{t(failure === "stale" ? "errors.stale" : "errors.generic")}</p>}
    </section>
  );
}
